import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSessionReadingBlocks } from './SessionReadingView';
import { SessionReadingView } from './SessionReadingView';
import { loadClaudeTranscript, loadCodexTranscript } from './terminalApi';

vi.mock('./terminalApi', () => ({
  loadClaudeTranscript: vi.fn(async () => []),
  loadCodexTranscript: vi.fn(async () => []),
}));

beforeEach(() => {
  vi.mocked(loadClaudeTranscript).mockClear();
  vi.mocked(loadCodexTranscript).mockClear();
});

describe('parseSessionReadingBlocks', () => {
  it('keeps a multiline prompt separate from the assistant reply', () => {
    const blocks = parseSessionReadingBlocks([
      '› 请分析这个问题',
      '第二行补充信息',
      '',
      '这是 AI 的第一段回复。',
      '',
      '› 继续处理',
      '',
      '⏺ 已完成第二次处理',
    ].join('\n'));

    expect(blocks.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: 'user', text: '请分析这个问题\n第二行补充信息' },
      { kind: 'assistant', text: '这是 AI 的第一段回复。' },
      { kind: 'user', text: '继续处理' },
      { kind: 'assistant', text: '已完成第二次处理' },
    ]);
  });

  it('filters TUI chrome and tool progress instead of showing process cards', () => {
    const blocks = parseSessionReadingBlocks([
      '[zz-claude-opus] | sample-project git:(main*)',
      'Context 18%',
      '✓ Explore: service/src/main',
      '⎿ 3 files found',
      '› 找出风险点',
      '',
      '⏺ 这里是最终回复。',
      'Worked for 12s',
      'high / effort',
    ].join('\n'));

    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe('user');
    expect(blocks[1]).toMatchObject({ kind: 'assistant', text: '这里是最终回复。' });
    expect(blocks.map((block) => block.text).join('\n')).not.toContain('service/src/main');
    expect(blocks.every((block) => block.kind !== 'process')).toBe(true);
  });

  it('only creates an error block for an explicitly marked error', () => {
    const blocks = parseSessionReadingBlocks([
      '› 检查异常处理',
      '',
      '答案中提到失败分支，但这是正常说明。',
      '',
      'Error: command exited with code 1',
    ].join('\n'));

    expect(blocks.map((block) => block.kind)).toEqual(['user', 'assistant', 'error']);
    expect(blocks[1].text).toContain('失败分支');
  });

  it('does not treat shell/status lines beginning with $ or > as user prompts', () => {
    const blocks = parseSessionReadingBlocks([
      '$ git status',
      '> progress 40%',
      '正常的历史输出',
    ].join('\n'));

    expect(blocks).toEqual([{ id: 0, kind: 'assistant', text: '$ git status\n> progress 40%\n正常的历史输出' }]);
  });

  it('does not turn ANSI cursor and color controls into artificial line breaks', () => {
    const blocks = parseSessionReadingBlocks('\u001b[38;5;6msample-project\u001b[39m \u001b[3G\u001b[2C正常的一句话\r\n下一行');

    expect(blocks[0].text).toBe('sample-project 正常的一句话\n下一行');
  });

  it('reopens Codex prose after a tool block without dropping the reply', () => {
    const blocks = parseSessionReadingBlocks([
      '› 请解释修改结果',
      '',
      'Update(sample-service/src/PricingService.java)',
      'Added 3 lines, removed 2 lines',
      '337 - old code',
      '338 + new code',
      'PostToolUse:Edit hook error',
      '需要纠正一下：这里只修改了月租阈值，业务逻辑没有变化。',
    ].join('\n'));

    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ kind: 'assistant', text: '需要纠正一下：这里只修改了月租阈值，业务逻辑没有变化。' });
  });

  it('ignores empty TUI prompts and prompt placeholders', () => {
    const blocks = parseSessionReadingBlocks(['›', '› Ask Codex to do anything', '› 真实问题'].join('\n'));

    expect(blocks).toEqual([{ id: 0, kind: 'user', text: '真实问题' }]);
  });

  it('ends the user block before the redraw chrome after an input prompt', () => {
    const blocks = parseSessionReadingBlocks(['❯ 请检查代码', '', '────────────────────', 'Context 60%', '← for agents', '', '⏺ 检查结果正常。'].join('\n'));

    expect(blocks.map((block) => [block.kind, block.text])).toEqual([
      ['user', '请检查代码'],
      ['assistant', '检查结果正常。'],
    ]);
  });

  it('filters animated tool status frames from Claude redraw output', () => {
    const blocks = parseSessionReadingBlocks([
      '◐ Explore:查找商品配置',
      'Fluttering… (12s)',
      '⎿ 3 files found',
      '› 请总结结果',
      '',
      '⏺ 已找到配置入口。',
    ].join('\n'));

    expect(blocks.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: 'user', text: '请总结结果' },
      { kind: 'assistant', text: '已找到配置入口。' },
    ]);
  });

  it('splits inline TUI redraw markers and never adds status chrome to user input', () => {
    const blocks = parseSessionReadingBlocks([
      '❯ 你好⏺你好！有什么可以帮你？✻ Churned for 7s',
      '──────────────────── [zz-claude-opus-5] │ sample-project git:(main*)',
      '❯ 11 + 1 = ?⏺12✻ Brewed for 4s',
      '›',
    ].join('\n'));

    expect(blocks.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: 'user', text: '你好' },
      { kind: 'assistant', text: '你好！有什么可以帮你？' },
      { kind: 'user', text: '11 + 1 = ?' },
      { kind: 'assistant', text: '12' },
    ]);
  });

  it('keeps only unique user prompts when alternate-screen redraw repeats them', () => {
    const blocks = parseSessionReadingBlocks([
      'Context 10%',
      '❯ 你好⏺你好！有什么可以帮你？✻ Churned for 7s',
      '❯ 11 + 1 = ?⏺12✻ Crunched for 4s',
      '❯ 你好⏺你好！有什么可以帮你？✻ Churned for 7s',
      '❯ 11 + 1 = ?⏺12✻ Crunched for 4s',
    ].join('\n'));

    expect(blocks.filter(({ kind }) => kind === 'user').map(({ text }) => text)).toEqual(['你好', '11 + 1 = ?']);
    expect(blocks.every(({ text }) => !/(?:Churned|Crunched|Context|for agents)/i.test(text))).toBe(true);
  });
});

describe('SessionReadingView markdown rendering', () => {
  it('uses the structured Codex transcript so TUI redraws do not become chat messages', async () => {
    vi.mocked(loadCodexTranscript).mockResolvedValueOnce([
      { kind: 'user', text: '请检查这个问题' },
      { kind: 'assistant', text: '这是结构化的 Codex 回复。' },
    ]);

    render(
      <SessionReadingView
        agent="codex"
        cliSessionId="019f8565-e310-7f73-b003-8d5bf94a7982"
        cwd="/tmp/project"
        history="› TUI 重绘乱码\nW Wo9 or rk ki in Wng"
      />,
    );

    await waitFor(() => expect(screen.getByText('这是结构化的 Codex 回复。')).toBeInTheDocument());

    expect(screen.getByText('请检查这个问题')).toBeInTheDocument();
    expect(screen.getAllByText('AI 回复').length).toBeGreaterThan(0);
    expect(screen.queryByText('TUI 重绘乱码')).not.toBeInTheDocument();
    expect(loadCodexTranscript).toHaveBeenCalledWith('/tmp/project', '019f8565-e310-7f73-b003-8d5bf94a7982');
    expect(loadClaudeTranscript).not.toHaveBeenCalled();
  });

  it('labels the user conversation filter as 你', () => {
    render(
      <SessionReadingView
        history={[
          '› 请检查这个问题',
          '',
          '⏺ 已完成检查。',
        ].join('\n')}
      />,
    );

    const filters = screen.getByLabelText('对话目录筛选');
    expect(within(filters).getByRole('button', { name: '你' })).toBeInTheDocument();
    expect(within(filters).queryByRole('button', { name: '我输入' })).not.toBeInTheDocument();
  });

  it('renders headings, emphasis, and inline commands as document content', () => {
    const { container } = render(
      <SessionReadingView
        history={[
          '**图 2 GC** —— 吞吐率 99.95%，FGC 为 0。',
          '',
          '## 关键发现',
          '',
          '- 堆使用率 26.00% ~ 76.76%',
          '- RSS 平均 11.847 GiB',
          '',
          '执行 `sips --cropOffset` 处理图片。',
        ].join('\n')}
      />,
    );

    expect(screen.getByText('图 2 GC')).toBeInTheDocument();
    expect(screen.getByText('图 2 GC').tagName).toBe('STRONG');
    expect(screen.getByRole('heading', { name: '关键发现' })).toBeInTheDocument();
    expect(screen.getByText('sips --cropOffset')).toHaveClass('reading-inline-code');
    expect(container.querySelector('.reading-diff-removed')).not.toBeInTheDocument();
    expect(container.querySelector('ul')).toBeInTheDocument();
  });

  it('renders diff colors only for an explicitly fenced diff block', () => {
    const { container } = render(
      <SessionReadingView
        history={[
          '```diff',
          '- old value',
          '+ new value',
          '```',
        ].join('\n')}
      />,
    );

    expect(container.querySelector('.reading-diff')).toBeInTheDocument();
    expect(container.querySelector('.reading-diff-removed')).toHaveTextContent('- old value');
    expect(container.querySelector('.reading-diff-added')).toHaveTextContent('+ new value');
  });
});
