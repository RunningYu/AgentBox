import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickPalette } from './QuickPalette';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
const { listen } = vi.hoisted(() => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('../../shared/promptpadStorage', () => ({
  loadCustomFeatures: vi.fn(async () => [
    { id: 'prompt-a', name: '日志分析', description: '分析日志', script: '请分析日志', builtin: false, type: 'prompt' },
    {
      id: 'workflow-a',
      name: '服务瘦身工作流',
      description: '逐步完成服务瘦身',
      script: '扫描无入口方法\n@@@STEP@@@\n整理删除清单',
      builtin: false,
      type: 'sequence',
      seqRule: 'confirm',
    },
  ]),
  loadPrefs: vi.fn(async () => ({ favorites: ['prompt-a', 'workflow-a'], order: ['prompt-a', 'workflow-a'] })),
  savePrefs: vi.fn(async () => undefined),
}));

describe('QuickPalette', () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockClear();
  });

  it('filters tools and copies the selected prompt to the clipboard', async () => {
    const user = userEvent.setup();
    render(<QuickPalette />);
    await screen.findByText('日志分析');
    await user.type(screen.getByRole('searchbox'), '日志');
    await user.click(screen.getByRole('button', { name: /日志分析/ }));
    expect(invoke).toHaveBeenCalledWith('set_clipboard_text', { text: '请分析日志' });
    expect(screen.getByText('复制成功，可到目标位置粘贴')).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('paste_to_previous_app', expect.anything());
  });

  it('shows imported tools by default even when they are not favorites', async () => {
    const user = userEvent.setup();
    const { loadPrefs } = await import('../../shared/promptpadStorage');
    vi.mocked(loadPrefs).mockResolvedValueOnce({ favorites: [], order: ['prompt-a', 'workflow-a'] });
    render(<QuickPalette />);

    expect(await screen.findByText('日志分析')).toBeInTheDocument();
    expect(screen.getByText('服务瘦身工作流')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '常用' }));
    expect(screen.queryByText('日志分析')).not.toBeInTheDocument();
    expect(screen.queryByText('服务瘦身工作流')).not.toBeInTheDocument();
  });

  it('renders the type filter inside the palette so it works across displays', async () => {
    const user = userEvent.setup();
    render(<QuickPalette />);
    await screen.findByText('日志分析');

    await user.click(screen.getByRole('button', { name: '功能类型：全部类型' }));
    expect(screen.getByRole('listbox', { name: '功能类型' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: '提示词' }));

    expect(screen.getByRole('button', { name: '功能类型：提示词' })).toBeInTheDocument();
    expect(screen.getByText('日志分析')).toBeInTheDocument();
    expect(screen.queryByText('服务瘦身工作流')).not.toBeInTheDocument();
  });

  it('refreshes configuration when the floating window receives focus', async () => {
    render(<QuickPalette />);
    await screen.findByText('日志分析');
    const { loadCustomFeatures } = await import('../../shared/promptpadStorage');
    const initialCalls = vi.mocked(loadCustomFeatures).mock.calls.length;

    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(vi.mocked(loadCustomFeatures).mock.calls.length).toBeGreaterThan(initialCalls));
  });

  it('does not show direct insertion, automatic Enter, or accessibility controls', async () => {
    const user = userEvent.setup();
    render(<QuickPalette />);
    await screen.findByText('日志分析');
    expect(screen.queryByRole('button', { name: '仅插入' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '插入并发送' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新请求授权' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开辅助功能设置' })).not.toBeInTheDocument();
  });

  it('supports arrow navigation and Enter execution without closing on Escape', async () => {
    render(<QuickPalette />);
    await screen.findByText('日志分析');
    const search = screen.getByRole('searchbox');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_clipboard_text', expect.anything()));
    invoke.mockClear();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(invoke).not.toHaveBeenCalledWith('hide_quick_palette');
  });

  it('stays visible when focus moves outside and only closes from the close button', async () => {
    const user = userEvent.setup();
    render(<QuickPalette />);
    await screen.findByText('日志分析');
    invoke.mockClear();

    fireEvent.blur(window);
    expect(invoke).not.toHaveBeenCalledWith('hide_quick_palette');
    await user.click(screen.getByRole('button', { name: '关闭快捷面板' }));
    expect(invoke).toHaveBeenCalledWith('hide_quick_palette');
  });

  it('delegates drag gestures to the native quick palette window', async () => {
    const { container } = render(<QuickPalette />);
    await screen.findByText('日志分析');
    fireEvent.mouseDown(container.querySelector('.quick-palette-dragbar')!, { button: 0 });
    expect(invoke).toHaveBeenCalledWith('start_quick_palette_drag');
  });

  it('opens a workflow step window instead of launching a terminal', async () => {
    const user = userEvent.setup();
    render(<QuickPalette />);
    await user.click(await screen.findByRole('button', { name: /服务瘦身工作流/ }));

    expect(screen.getByRole('heading', { name: '服务瘦身工作流' })).toBeInTheDocument();
    expect(screen.getByText('扫描无入口方法')).toBeInTheDocument();
    expect(screen.getByText('整理删除清单')).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('open_system_terminal', expect.anything());
  });

  it('copies a selected workflow step without targeting an external input', async () => {
    const user = userEvent.setup();
    render(<QuickPalette />);
    await user.click(await screen.findByRole('button', { name: /服务瘦身工作流/ }));
    await user.click(screen.getByRole('button', { name: '复制步骤 1' }));

    expect(invoke).toHaveBeenCalledWith('set_clipboard_text', { text: '扫描无入口方法' });
    expect(screen.getByText('复制成功，可到目标位置粘贴')).toBeInTheDocument();
  });

  it('keeps PromptPad editing and copies its final content', async () => {
    const user = userEvent.setup();
    render(<QuickPalette />);
    await screen.findByText('日志分析');
    await user.click(screen.getByRole('button', { name: '全部' }));
    await user.click(screen.getByRole('button', { name: /PromptPad/ }));
    await user.type(screen.getByPlaceholderText('输入提示词、命令或任意文本'), '整理这段需求');
    await user.click(screen.getByRole('button', { name: '复制内容' }));

    expect(invoke).toHaveBeenCalledWith('set_clipboard_text', { text: '整理这段需求' });
    expect(screen.getByText('复制成功，可到目标位置粘贴')).toBeInTheDocument();
  });
});
