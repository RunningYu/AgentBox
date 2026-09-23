import { readFileSync } from 'node:fs';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiSessionRecord, AiWorkspaceArchive } from '../../shared/types';
import { normalizeFeature } from '../../shared/featureModel';
import '../../styles.css';
import { AiWorkspace } from './AiWorkspace';
import * as documentApi from './documentApi';
import * as terminalApi from './terminalApi';
import * as terminalGeometry from './terminalGeometry';

const loadAiWorkspace = vi.fn<() => Promise<AiWorkspaceArchive>>();
const saveAiWorkspace = vi.fn<(archive: AiWorkspaceArchive) => Promise<void>>();
const loadAiSessionHistory = vi.fn<(sessionId: string) => Promise<string>>();
const appendAiSessionHistory = vi.fn<(sessionId: string, data: string) => Promise<void>>();
const commitAiSessionDeletion = vi.fn<(archive: AiWorkspaceArchive, sessionIds: string[]) => Promise<void>>();
const stylesCss = readFileSync('src/styles.css', 'utf8');
const terminalViewMounts = vi.hoisted(() => [] as string[]);
let outputHandler: ((event: terminalApi.PtyOutputEvent) => void) | undefined;
let exitHandler: ((event: terminalApi.PtyExitEvent) => void) | undefined;
let quickPaletteInsertHandler: ((event: { payload: { text: string; append_enter: boolean } }) => void) | undefined;
let speechHandler: ((event: { kind: string; recordingId: string; text?: string; message?: string; isFinal?: boolean }) => void) | undefined;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

vi.mock('../../shared/promptpadStorage', () => ({
  appendAiSessionHistory: (sessionId: string, data: string) => appendAiSessionHistory(sessionId, data),
  commitAiSessionDeletion: (archive: AiWorkspaceArchive, sessionIds: string[]) => commitAiSessionDeletion(archive, sessionIds),
  loadAiSessionHistory: (sessionId: string) => loadAiSessionHistory(sessionId),
  loadAiWorkspace: () => loadAiWorkspace(),
  saveAiWorkspace: (archive: AiWorkspaceArchive) => saveAiWorkspace(archive),
}));

vi.mock('./terminalApi', () => ({
  agentSessionExists: vi.fn(),
  completeGuiMessage: vi.fn(),
  chooseWorkingDirectory: vi.fn(),
  validateWorkingDirectory: vi.fn(),
  findAgentSessionId: vi.fn(),
  findPtySessionId: vi.fn(),
  getClipboardText: vi.fn(),
  listAgentSkills: vi.fn(),
  loadClaudeTranscript: vi.fn(async () => []),
  listenPtyExit: vi.fn(async (handler) => {
    exitHandler = handler;
    return () => undefined;
  }),
  listenPtyOutput: vi.fn(async (handler) => {
    outputHandler = handler;
    return () => undefined;
  }),
  pollPty: vi.fn(),
  resizePty: vi.fn(),
  setClipboardText: vi.fn(),
  startPty: vi.fn(),
  stopPty: vi.fn(),
  subscribePtyChannel: vi.fn((onOutput, onExit) => {
    outputHandler = onOutput;
    exitHandler = onExit;
    return () => undefined;
  }),
  preparePtyRestart: vi.fn(),
  writePty: vi.fn(),
}));

vi.mock('./terminalGeometry', () => ({
  waitForTerminalGeometry: vi.fn().mockResolvedValue({ cols: 80, rows: 24 }),
}));

vi.mock('./speechApi', () => ({
  listenSpeechEvents: vi.fn(async (handler) => {
    speechHandler = handler;
    return () => undefined;
  }),
  startSpeechRecognition: vi.fn(),
  stopSpeechRecognition: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: (payload: unknown) => void) => {
    if (event === 'quick-palette-insert-main') {
      quickPaletteInsertHandler = handler as typeof quickPaletteInsertHandler;
    }
    return () => undefined;
  }),
}));

vi.mock('./documentApi', () => ({
  chooseDocumentDirectory: vi.fn(),
  chooseDocumentFile: vi.fn(),
  listDocumentTree: vi.fn(),
  readContextFile: vi.fn(),
  readDocumentFile: vi.fn(),
}));

vi.mock('./changeTrackerApi', () => ({
  scanRecentChanges: vi.fn(async () => []),
}));

vi.mock('./TerminalView', async () => {
  const React = await import('react');
  return {
    TerminalView: ({ clearVersion, history, sessionId }: { clearVersion: number; history: string; sessionId: string }) => {
      const instance = React.useRef(`${sessionId}:${terminalViewMounts.length}`).current;
      React.useEffect(() => {
        terminalViewMounts.push(instance);
      }, [instance]);
      return <div data-testid={`terminal-${sessionId}`} data-terminal-instance={instance}>{`clear-${clearVersion}:${history}`}</div>;
    },
  };
});

function persistedSession(overrides: Partial<AiSessionRecord> = {}): AiSessionRecord {
  return {
    id: 'session-1',
    name: '历史会话',
    agent: 'claude',
    cwd: '/tmp',
    status: 'stopped',
    groupId: null,
    history: 'history',
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    ...overrides,
  };
}

function archive(sessions: AiSessionRecord[] = []): AiWorkspaceArchive {
  return { version: 2, groups: [], sessions: sessions.map(({ history: _history, generation: _generation, error: _error, ...session }) => session) };
}

function groupedArchive(sessions: AiSessionRecord[] = []): AiWorkspaceArchive {
  return {
    version: 2,
    groups: [{ id: 'group-1', name: '服务瘦身', createdAt: 1, collapsed: false }],
    sessions: sessions.map(({ history: _history, generation: _generation, error: _error, ...session }) => session),
  };
}

function getFeatureHit(name: RegExp) {
  const button = screen.getAllByRole('button', { name }).find((item) => item.classList.contains('feature-hit'));
  if (!button) {
    throw new Error(`Feature hit not found for ${name}`);
  }
  return button;
}


function dispatchPointer(target: EventTarget, type: string, clientX: number) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    clientX: { value: clientX },
    pointerId: { value: 1 },
  });
  target.dispatchEvent(event);
}

async function showToolbox(user: ReturnType<typeof userEvent.setup>) {
  const button = screen.queryByRole('button', { name: '显示工具箱' });
  if (button) {
    await user.click(button);
  }
}

async function createSession(agent: 'claude' | 'codex' | 'terminal' | 'gui' = 'claude') {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '在未分组中新建会话' }));
  await user.clear(screen.getByLabelText('会话名称'));
  await user.type(screen.getByLabelText('会话名称'), `${agent} session`);
  if (agent === 'codex') {
    await user.click(screen.getByRole('button', { name: 'Codex' }));
  } else if (agent === 'terminal') {
    await user.click(screen.getByRole('button', { name: '终端' }));
  } else if (agent === 'gui') {
    await user.click(screen.getByRole('button', { name: 'GUI' }));
  }
  await user.type(screen.getByLabelText('工作目录'), '/tmp');
  await user.click(screen.getByRole('button', { name: '创建并启动' }));
  return user;
}

describe('AiWorkspace', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    terminalViewMounts.length = 0;
    outputHandler = undefined;
    exitHandler = undefined;
    quickPaletteInsertHandler = undefined;
    speechHandler = undefined;
    loadAiWorkspace.mockResolvedValue(archive());
    saveAiWorkspace.mockResolvedValue();
    loadAiSessionHistory.mockImplementation(async (sessionId) => (
      sessionId === 'session-1' ? 'history' : ''
    ));
    appendAiSessionHistory.mockResolvedValue();
    commitAiSessionDeletion.mockResolvedValue();
    vi.mocked(terminalApi.startPty).mockResolvedValue();
    vi.mocked(terminalApi.validateWorkingDirectory).mockResolvedValue();
    vi.mocked(terminalGeometry.waitForTerminalGeometry).mockResolvedValue({ cols: 80, rows: 24 });
    vi.mocked(terminalApi.agentSessionExists).mockResolvedValue(true);
    vi.mocked(terminalApi.pollPty).mockResolvedValue({ data: '', running: true });
    vi.mocked(terminalApi.writePty).mockResolvedValue();
    vi.mocked(terminalApi.stopPty).mockResolvedValue();
    vi.mocked(terminalApi.preparePtyRestart).mockResolvedValue();
    vi.mocked(terminalApi.findAgentSessionId).mockResolvedValue(null);
    vi.mocked(terminalApi.findPtySessionId).mockResolvedValue(null);
    vi.mocked(terminalApi.completeGuiMessage).mockResolvedValue('GUI 模型回复');
    vi.mocked(terminalApi.listAgentSkills).mockResolvedValue([]);
    vi.mocked(terminalApi.getClipboardText).mockResolvedValue('');
    vi.mocked(documentApi.chooseDocumentFile).mockResolvedValue(null);
    vi.mocked(documentApi.chooseDocumentDirectory).mockResolvedValue(null);
    vi.mocked(documentApi.listDocumentTree).mockResolvedValue([]);
    vi.mocked(documentApi.readContextFile).mockResolvedValue({
      content: '',
      extension: 'md',
      name: 'empty.md',
      path: '/tmp/empty.md',
      size: 0,
    });
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      content: '',
      extension: 'md',
      name: 'empty.md',
      path: 'empty.md',
      size: 0,
    });
    window.localStorage.clear();
  });

  it('falls back to an empty workspace without reporting a browser storage error', async () => {
    const onMessage = vi.fn();
    loadAiWorkspace.mockRejectedValueOnce(new Error('Cannot read properties of undefined (reading \'invoke\')'));

    render(<AiWorkspace onMessage={onMessage} />);

    expect(await screen.findByText('新建一个 Claude Code 或 Codex 会话')).toBeInTheDocument();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('creates and starts a Claude Code session', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');

    await createSession('claude');

    const call = vi.mocked(terminalApi.startPty).mock.calls[0];
    expect(call.slice(0, 4)).toEqual([expect.any(String), expect.any(String), 'claude', '/tmp']);
    expect(call[4]).toEqual({
      cliSessionId: call[0],
      resume: false,
      fallbackResume: false,
      cols: 80,
      rows: 24,
    });
    expect(await screen.findByRole('button', { name: /claude session 运行中/ })).toBeInTheDocument();
  });

  it('keeps the create dialog open and does not create a session when the working directory is invalid', async () => {
    const onMessage = vi.fn();
    vi.mocked(terminalApi.validateWorkingDirectory).mockRejectedValueOnce(new Error('工作目录不存在: /missing-directory'));
    render(<AiWorkspace onMessage={onMessage} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '在未分组中新建会话' }));
    await user.clear(screen.getByLabelText('会话名称'));
    await user.type(screen.getByLabelText('会话名称'), '无效目录会话');
    await user.type(screen.getByLabelText('工作目录'), '/missing-directory');
    await user.click(screen.getByRole('button', { name: '创建并启动' }));

    expect(terminalApi.validateWorkingDirectory).toHaveBeenCalledWith('/missing-directory');
    expect(terminalApi.startPty).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: '新建 AI 会话' })).toBeInTheDocument();
    expect(screen.getByLabelText('工作目录')).toHaveValue('/missing-directory');
    expect(screen.getByRole('alert')).toHaveTextContent('工作目录不存在: /missing-directory');
    expect(screen.queryByRole('button', { name: /无效目录会话/ })).not.toBeInTheDocument();
    expect(onMessage).toHaveBeenCalledWith('工作目录不存在: /missing-directory');
  });

  it.each([
    {
      agentType: 'claude' as const,
      agentName: '需求分析 Agent',
      model: 'Claude Sonnet 4.6',
      prompt: '先澄清目标，再给出方案与待办。',
      skill: 'requirements-analysis',
      color: '#3f82d8',
    },
    {
      agentType: 'codex' as const,
      agentName: '代码审查 Agent',
      model: 'gpt-5.5',
      prompt: '先定位缺陷，再给出修复建议。',
      skill: 'code-review',
      color: '#8a63c7',
    },
  ])('creates an Agent session directly from a group with a $agentType Agent', async ({ agentType, agentName, model, prompt, skill, color }) => {
    loadAiWorkspace.mockResolvedValue(groupedArchive());
    window.localStorage.setItem('agentbox.agent-center.v1', JSON.stringify([{
      id: `agent-${agentType}`,
      name: agentName,
      description: '拆解需求与风险',
      type: agentType,
      model,
      cwd: '/tmp',
      color,
      prompt,
      skillNames: [skill],
      knowledgeBases: ['/tmp/requirements'],
      mcps: ['文档检索'],
    }]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByRole('heading', { name: '服务瘦身' });

    await user.click(screen.getByRole('button', { name: '在服务瘦身中新建 Agent 会话' }));
    expect(await screen.findByRole('heading', { name: '从 Agent 创建会话' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: new RegExp(agentName) }));

    await waitFor(() => expect(terminalApi.startPty).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      agentType,
      '/tmp',
      expect.objectContaining({ resume: false, agentContext: expect.stringContaining('最高优先级上下文') }),
    ));
    const call = vi.mocked(terminalApi.startPty).mock.calls[0];
    expect(call[4]?.model).toBe(model);
    expect(call[4]?.agentContext).toContain(agentName);
    expect(call[4]?.agentContext).toContain(skill);
    expect(call[4]?.agentContext).toContain(prompt);
    expect(screen.queryByRole('heading', { name: '新建 AI 会话' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Agent 会话配置' })).toBeInTheDocument();
    expect(screen.getByText(skill)).toBeInTheDocument();
    await waitFor(() => expect(saveAiWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      sessions: expect.arrayContaining([expect.objectContaining({
        agentConfig: expect.objectContaining({ agentName }),
        groupId: 'group-1',
      })]),
    })));
  });

  it('does not show internal Tauri event ACL errors as user-facing messages', async () => {
    const onMessage = vi.fn();
    vi.mocked(terminalApi.listenPtyOutput).mockRejectedValueOnce(new Error('Command plugin:event|listen not allowed by ACL'));
    vi.mocked(terminalApi.listenPtyExit).mockRejectedValueOnce(new Error('Command plugin:event|listen not allowed by ACL'));

    render(<AiWorkspace onMessage={onMessage} />);

    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    expect(onMessage).not.toHaveBeenCalledWith(expect.stringContaining('plugin:event|listen'));
  });

  it('creates a Codex session when selected', async () => {
    const ownCliSessionId = '01a02256-ef08-7db2-9d03-62d77304c323';
    const unrelatedCliSessionId = '01a0223d-9f12-7640-96dd-c5699dde4605';
    vi.mocked(terminalApi.findPtySessionId).mockResolvedValue(ownCliSessionId);
    vi.mocked(terminalApi.findAgentSessionId).mockResolvedValue(unrelatedCliSessionId);
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');

    await createSession('codex');

    expect(terminalApi.startPty).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'codex',
      '/tmp',
      { cliSessionId: undefined, resume: false, fallbackResume: false, cols: 80, rows: 24 },
    );
    const [sessionId, generation] = vi.mocked(terminalApi.startPty).mock.calls[0];
    await waitFor(() => expect(terminalApi.findPtySessionId).toHaveBeenCalledWith(sessionId, generation, 'codex', '/tmp'));
    expect(terminalApi.findAgentSessionId).not.toHaveBeenCalled();
    await waitFor(() => expect(saveAiWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ sessions: expect.arrayContaining([expect.objectContaining({ cliSessionId: ownCliSessionId })]) }),
    ));
  });

  it('creates a plain terminal session when selected', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');

    await createSession('terminal');

    expect(terminalApi.startPty).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'terminal',
      '/tmp',
      { cliSessionId: undefined, resume: false, fallbackResume: false, cols: 80, rows: 24 },
    );
    expect(await screen.findByRole('button', { name: /terminal session 运行中/ })).toBeInTheDocument();
  });

  it('creates a GUI session without starting a PTY and records composer messages', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');

    const user = await createSession('gui');

    expect(terminalApi.startPty).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /gui session 运行中/ })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'GUI 会话' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('发送到当前终端'), '打开商品列表页');
    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(terminalApi.writePty).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('打开商品列表页')).toBeInTheDocument());
    expect(terminalApi.completeGuiMessage).toHaveBeenCalledWith('claude', 'sonnet', '/tmp', '打开商品列表页');
    await waitFor(() => expect(screen.getByText('GUI 模型回复')).toBeInTheDocument());
    expect(appendAiSessionHistory).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('打开商品列表页'));
    expect(appendAiSessionHistory).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('GUI 模型回复'));
  });

  it('creates and starts a restored Codex session from a pasted resume command', async () => {
    const cliSessionId = '019f8dbe-9ae7-7150-948e-36cbf107ebdd';
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '在未分组中新建会话' }));
    await user.click(screen.getByRole('button', { name: '恢复已有会话' }));
    await user.clear(screen.getByLabelText('会话名称'));
    await user.type(screen.getByLabelText('会话名称'), '恢复 Codex');
    await user.type(screen.getByLabelText('工作目录'), '/tmp/agentbox-project');
    await user.type(screen.getByLabelText('恢复命令或会话 ID'), `codex resume ${cliSessionId}`);
    await user.click(screen.getByRole('button', { name: '创建并恢复' }));

    expect(terminalApi.startPty).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'codex',
      '/tmp/agentbox-project',
      { cliSessionId, resume: true, fallbackResume: false, cols: 80, rows: 24 },
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /恢复 Codex 运行中/ })).toBeInTheDocument());
  });

  it('uses the most recently created session directory as the next default', async () => {
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');

    await user.click(screen.getByRole('button', { name: '在未分组中新建会话' }));
    await user.type(screen.getByLabelText('工作目录'), '/tmp/agentbox-latest');
    await user.click(screen.getByRole('button', { name: '创建并启动' }));
    await user.click(screen.getByRole('button', { name: '在未分组中新建会话' }));

    expect(screen.getByLabelText('工作目录')).toHaveValue('/tmp/agentbox-latest');
  });

  it('allows an empty starting Claude session to pause before its PTY is created', async () => {
    const geometry = deferred<{ cols: number; rows: number }>();
    vi.mocked(terminalGeometry.waitForTerminalGeometry).mockReturnValueOnce(geometry.promise);
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');

    await user.click(screen.getByRole('button', { name: '在未分组中新建会话' }));
    await user.type(screen.getByLabelText('工作目录'), '/tmp/empty-claude');
    await user.click(screen.getByRole('button', { name: '创建并启动' }));
    await user.click(screen.getByRole('button', { name: '停止会话' }));
    geometry.resolve({ cols: 80, rows: 24 });

    await waitFor(() => expect(screen.getByRole('button', { name: /Claude Code 会话 已停止/ })).toBeInTheDocument());
    expect(terminalApi.startPty).not.toHaveBeenCalled();
    expect(terminalApi.stopPty).not.toHaveBeenCalled();
  });

  it('waits for an in-flight PTY startup before stopping the session', async () => {
    const startup = deferred<void>();
    vi.mocked(terminalApi.startPty).mockReturnValueOnce(startup.promise);
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');

    await user.click(screen.getByRole('button', { name: '在未分组中新建会话' }));
    await user.type(screen.getByLabelText('工作目录'), '/tmp/starting-claude');
    await user.click(screen.getByRole('button', { name: '创建并启动' }));
    await user.click(screen.getByRole('button', { name: '停止会话' }));

    expect(terminalApi.stopPty).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Claude Code 会话 停止中/ })).toBeInTheDocument();

    startup.resolve();
    await waitFor(() => expect(terminalApi.stopPty).toHaveBeenCalledWith(expect.any(String), expect.any(String)));
    await waitFor(() => expect(screen.getByRole('button', { name: /Claude Code 会话 已停止/ })).toBeInTheDocument());
  });

  it('keeps a running session stoppable when stopping the PTY fails', async () => {
    const onMessage = vi.fn();
    render(<AiWorkspace onMessage={onMessage} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession();
    vi.mocked(terminalApi.stopPty).mockRejectedValueOnce(new Error('终止失败'));

    await user.click(screen.getByRole('button', { name: '停止会话' }));

    await waitFor(() => expect(onMessage).toHaveBeenCalledWith('终止失败'));
    expect(screen.getByRole('button', { name: 'claude session 运行中' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '停止会话' })).toBeEnabled();
  });

  it('duplicates a session with the same name, agent, directory and group', async () => {
    loadAiWorkspace.mockResolvedValue(groupedArchive([
      persistedSession({ id: 'source', name: '业务梳理', agent: 'codex', cwd: '/tmp/project', groupId: 'group-1' }),
    ]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '业务梳理 会话操作' }));
    await user.click(screen.getByRole('menuitem', { name: '复制会话' }));

    expect(terminalApi.startPty).toHaveBeenCalledWith(
      expect.not.stringMatching(/^source$/),
      expect.any(String),
      'codex',
      '/tmp/project',
      { cliSessionId: undefined, resume: false, fallbackResume: false, cols: 80, rows: 24 },
    );
    expect(await screen.findAllByRole('button', { name: /业务梳理 运行中/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /业务梳理 (已停止|运行中)/ })).toHaveLength(2);
  });

  it('explains an unresolved Codex writer and restarts in the same list item', async () => {
    const cliSessionId = '019f7b31-5706-7c31-9818-8f27a1bf03d8';
    loadAiWorkspace.mockResolvedValue(archive([
      persistedSession({ agent: 'codex', cliSessionId, name: '梳理' }),
    ]));
    vi.mocked(terminalApi.startPty)
      .mockRejectedValueOnce(new Error(`Codex 会话 ${cliSessionId} 正在其他终端运行（PID 35468）`))
      .mockResolvedValueOnce();
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '重新启动' }));
    await waitFor(() => expect(terminalApi.startPty).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/writer 尚未释放/)).toBeInTheDocument();
    expect(screen.getByText(/无法仅凭该错误判断是其他终端.*残留进程/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '在此重启新会话' }));

    await waitFor(() => {
      expect(terminalApi.startPty).toHaveBeenLastCalledWith(
        'session-1',
        expect.any(String),
        'codex',
        '/tmp',
        { cliSessionId: undefined, resume: false, fallbackResume: false, cols: 80, rows: 24 },
      );
    });
    expect(screen.getAllByRole('button', { name: '梳理 运行中' })).toHaveLength(1);
  });

  it('waits for the failed PTY to stop before replacing an active-writer Codex session', async () => {
    const cliSessionId = '01a0223d-9f12-7640-96dd-c5699dde4605';
    const cleanup = deferred<void>();
    loadAiWorkspace.mockResolvedValue(archive([
      persistedSession({ agent: 'codex', cliSessionId, name: '定价方案' }),
    ]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '重新启动' }));
    const [sessionId, generation] = vi.mocked(terminalApi.startPty).mock.calls[0];
    act(() => {
      outputHandler?.({
        sessionId,
        generation,
        data: `thread/resume failed: thread ${cliSessionId} already has an active writer (code -32600)\r\n`,
      });
    });
    vi.mocked(terminalApi.preparePtyRestart).mockReturnValueOnce(cleanup.promise);

    await user.click(await screen.findByRole('button', { name: '在此重启新会话' }));

    expect(terminalApi.preparePtyRestart).toHaveBeenLastCalledWith('session-1');
    expect(terminalApi.startPty).toHaveBeenCalledTimes(1);

    cleanup.resolve();
    await waitFor(() => expect(terminalApi.startPty).toHaveBeenCalledTimes(2));
    expect(terminalApi.startPty).toHaveBeenLastCalledWith(
      'session-1',
      expect.any(String),
      'codex',
      '/tmp',
      { cliSessionId: undefined, resume: false, fallbackResume: false, cols: 80, rows: 24 },
    );
    expect(screen.getAllByRole('button', { name: '定价方案 运行中' })).toHaveLength(1);
  });

  it('shows the group and position when a restored CLI session already exists', async () => {
    const cliSessionId = '256f50a7-62ed-45bc-abf6-f90ece54c58c';
    const onMessage = vi.fn();
    loadAiWorkspace.mockResolvedValue(groupedArchive([
      persistedSession({ id: 'first', name: '第一会话', groupId: 'group-1', cliSessionId: '019f8565-e310-7f73-b003-8d5bf94a7982', pinned: true }),
      persistedSession({ id: 'second', name: '已存在会话', groupId: 'group-1', cliSessionId }),
    ]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={onMessage} />);

    await user.click(await screen.findByRole('button', { name: '在服务瘦身中新建会话' }));
    await user.click(screen.getByRole('button', { name: '恢复已有会话' }));
    await user.type(screen.getByLabelText('工作目录'), '/tmp/agentbox-project');
    await user.type(screen.getByLabelText('恢复命令或会话 ID'), `claude --resume ${cliSessionId}`);
    await user.click(screen.getByRole('button', { name: '创建并恢复' }));

    expect(terminalApi.startPty).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith('该会话 ID 已存在于「服务瘦身」分组第 2 个：已存在会话');
  });

  it('keeps looking until a new Codex session id is written and saved', async () => {
    const cliSessionId = '019f8565-e310-7f73-b003-8d5bf94a7982';
    let attempts = 0;
    vi.mocked(terminalApi.findPtySessionId).mockImplementation(async () => {
      attempts += 1;
      return attempts >= 3 ? cliSessionId : null;
    });
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');

    await createSession('codex');

    await waitFor(
      () => expect(saveAiWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ sessions: expect.arrayContaining([expect.objectContaining({ cliSessionId })]) }),
      ),
      { timeout: 10_000 },
    );
  }, 12_000);

  it('switches sessions without stopping either process', async () => {
    loadAiWorkspace.mockResolvedValue(archive([
      persistedSession(),
      persistedSession({ id: 'session-2', name: '第二会话', agent: 'codex', updatedAt: 2 }),
    ]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '历史会话 已停止' }));

    expect(screen.getByTestId('terminal-session-1')).toBeInTheDocument();
    expect(terminalApi.stopPty).not.toHaveBeenCalled();
  });

  it('preserves the live terminal instance while toggling reading view', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    const user = await createSession('claude');
    const sessionId = vi.mocked(terminalApi.startPty).mock.calls[0][0];
    const terminal = await screen.findByTestId(`terminal-${sessionId}`);

    await user.click(screen.getByRole('button', { name: '切换到阅读视图' }));

    expect(terminal).toBeInTheDocument();
    expect(terminal.closest('.terminal-slot')).toHaveAttribute('hidden');

    await user.click(screen.getByRole('button', { name: '切换到终端视图' }));

    expect(screen.getByTestId(`terminal-${sessionId}`)).toBe(terminal);
    expect(terminal.closest('.terminal-slot')).not.toHaveAttribute('hidden');
  });

  it('does not show the previous session history in a newly created session', async () => {
    loadAiWorkspace.mockResolvedValue(archive([persistedSession({ history: 'previous session output' })]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await screen.findByTestId('terminal-session-1');
    await user.click(screen.getByRole('button', { name: '在未分组中新建会话' }));
    await user.clear(screen.getByLabelText('会话名称'));
    await user.type(screen.getByLabelText('会话名称'), 'new session');
    await user.type(screen.getByLabelText('工作目录'), '/tmp');
    await user.click(screen.getByRole('button', { name: '创建并启动' }));

    const newSessionId = vi.mocked(terminalApi.startPty).mock.calls[0][0];
    expect(screen.getByTestId(`terminal-${newSessionId}`)).not.toHaveTextContent('previous session output');
  });

  it('sends composer text followed by a full enter sequence', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession();

    await user.type(screen.getByLabelText('发送到当前终端'), '执行测试');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(terminalApi.writePty).toHaveBeenCalledWith(expect.any(String), expect.any(String), '执行测试\r\n'));
    expect(screen.getByLabelText('发送到当前终端')).toHaveValue('');
  });

  it('sends multiline composer text as bracketed paste before pressing enter', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession();

    await user.type(screen.getByLabelText('发送到当前终端'), '需求1\n\t1、保留缩进');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(terminalApi.writePty).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      '\u001b[200~需求1\n\t1、保留缩进\u001b[201~\r',
    ));
    expect(screen.getByLabelText('发送到当前终端')).toHaveValue('');
  });

  it('inserts a newline on Shift+Enter in the composer', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession();
    const composer = screen.getByLabelText('发送到当前终端');

    await user.type(composer, '第二行');
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(composer).toHaveValue('第二行\n');
    expect(terminalApi.writePty).not.toHaveBeenCalled();
  });

  it('inserts speech transcripts at the composer cursor without sending them', async () => {
    const user = userEvent.setup();
    const { startSpeechRecognition, stopSpeechRecognition } = await import('./speechApi');
    const stopped = deferred<Awaited<ReturnType<typeof stopSpeechRecognition>>>();
    vi.mocked(startSpeechRecognition).mockResolvedValue('speech-1');
    vi.mocked(stopSpeechRecognition).mockReturnValue(stopped.promise);
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    await createSession();

    const composer = screen.getByLabelText('发送到当前终端') as HTMLTextAreaElement;
    await user.type(composer, '前后');
    composer.setSelectionRange(1, 1);
    composer.dispatchEvent(new Event('select', { bubbles: true }));
    await user.click(screen.getByRole('button', { name: '开始语音输入' }));

    expect(screen.getByRole('button', { name: '停止语音输入' })).toBeInTheDocument();
    const stopClick = user.click(screen.getByRole('button', { name: '停止语音输入' }));
    await waitFor(() => expect(stopSpeechRecognition).toHaveBeenCalledWith('speech-1'));

    act(() => {
      speechHandler?.({ kind: 'status', recordingId: 'speech-1', message: '正在准备中文语音模型' });
    });
    expect(screen.getByRole('button', { name: '正在准备中文语音模型' })).toBeInTheDocument();

    act(() => {
      speechHandler?.({ kind: 'transcript', recordingId: 'speech-1', text: '语音输入', isFinal: true });
      stopped.resolve({ kind: 'transcript', recordingId: 'speech-1', text: '语音输入', isFinal: true });
    });
    await stopClick;
    expect(composer).toHaveValue('前语音输入后');
    expect(terminalApi.writePty).not.toHaveBeenCalled();
  });

  it('replays a speech failure that arrives before the recording id', async () => {
    const user = userEvent.setup();
    const onMessage = vi.fn();
    const start = deferred<string>();
    const { startSpeechRecognition } = await import('./speechApi');
    vi.mocked(startSpeechRecognition).mockReturnValue(start.promise);
    render(<AiWorkspace onMessage={onMessage} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    await createSession();

    const click = user.click(screen.getByRole('button', { name: '开始语音输入' }));
    await waitFor(() => expect(startSpeechRecognition).toHaveBeenCalled());
    act(() => {
      speechHandler?.({
        kind: 'error',
        recordingId: 'speech-early-error',
        message: '语音组件启动失败',
      });
      start.resolve('speech-early-error');
    });
    await click;

    await waitFor(() => expect(onMessage).toHaveBeenCalledWith('语音组件启动失败'));
    expect(screen.getByRole('button', { name: '开始语音输入' })).toBeInTheDocument();
  });

  it('inserts the stop response transcript when the speech event is lost', async () => {
    const user = userEvent.setup();
    const { startSpeechRecognition, stopSpeechRecognition } = await import('./speechApi');
    vi.mocked(startSpeechRecognition).mockResolvedValue('speech-stop-result');
    vi.mocked(stopSpeechRecognition).mockResolvedValue({
      kind: 'transcript',
      recordingId: 'speech-stop-result',
      text: '兜底转写文字',
      isFinal: true,
    } as never);
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    await createSession();

    await user.click(screen.getByRole('button', { name: '开始语音输入' }));
    await user.click(screen.getByRole('button', { name: '停止语音输入' }));

    expect(screen.getByLabelText('发送到当前终端')).toHaveValue('兜底转写文字');
    expect(terminalApi.writePty).not.toHaveBeenCalled();
  });

  it('inserts quick palette text at the saved composer cursor in the main app', async () => {
    render(<AiWorkspace onMessage={() => undefined} />);
    await screen.findByText('未分组');
    const user = await createSession('terminal');
    const composer = screen.getByLabelText('发送到当前终端') as HTMLTextAreaElement;
    await user.type(composer, '前后');
    composer.setSelectionRange(1, 1);

    act(() => quickPaletteInsertHandler?.({
      payload: { text: '插入', append_enter: false },
    }));

    await waitFor(() => expect(composer).toHaveValue('前插入后'));
    await waitFor(() => {
      expect(composer.selectionStart).toBe(3);
      expect(composer.selectionEnd).toBe(3);
    });
  });

  it('restores deleted composer text with Cmd+Z and reapplies deletion with Cmd+Shift+Z', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession();
    const composer = screen.getByLabelText('发送到当前终端');

    await user.type(composer, '准备审查这段代码');
    await user.clear(composer);
    expect(composer).toHaveValue('');

    await user.keyboard('{Meta>}z{/Meta}');
    expect(composer).toHaveValue('准备审查这段代码');

    await user.keyboard('{Meta>}{Shift>}z{/Shift}{/Meta}');
    expect(composer).toHaveValue('');
  });

  it('undoes composer edits step by step like a text editor', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession();
    const composer = screen.getByLabelText('发送到当前终端');

    await user.type(composer, '第一版');
    await user.clear(composer);
    await user.type(composer, '第二版');

    await user.keyboard('{Meta>}z{/Meta}');
    expect(composer).toHaveValue('');

    await user.keyboard('{Meta>}z{/Meta}');
    expect(composer).toHaveValue('第一版');
  });

  it('restores composer text with Cmd+Z after sending clears the input', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession();
    const composer = screen.getByLabelText('发送到当前终端');

    await user.type(composer, '执行测试');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(composer).toHaveValue(''));

    await user.keyboard('{Meta>}z{/Meta}');

    expect(composer).toHaveValue('执行测试');
  });

  it('suggests agent skills when typing a slash command and inserts the selected command', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession('codex');
    const composer = screen.getByLabelText('发送到当前终端');

    await user.type(composer, '/project-l');

    expect(await screen.findByRole('option', { name: /\/project-logs/ })).toBeInTheDocument();

    await user.keyboard('{Enter}');

    expect(composer).toHaveValue('/project-logs ');
    expect(terminalApi.writePty).not.toHaveBeenCalled();
  });

  it('suggests common CLI commands for Claude sessions', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession('claude');
    const composer = screen.getByLabelText('发送到当前终端');

    await user.type(composer, '/mod');

    expect(await screen.findByRole('option', { name: /\/model/ })).toBeInTheDocument();
  });

  it('matches custom prompt commands by Chinese names after slash', async () => {
    render(
      <AiWorkspace
        features={[
          normalizeFeature({
            id: 'online-bug',
            name: '线上bug排查',
            description: '排查线上问题',
            script: '请排查线上 bug',
            builtin: false,
            type: 'prompt',
          }),
        ]}
        onMessage={vi.fn()}
      />,
    );
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession();
    const composer = screen.getByLabelText('发送到当前终端');

    await user.type(composer, '/线上');
    expect(await screen.findByRole('option', { name: /\/线上bug排查/ })).toBeInTheDocument();

    await user.clear(composer);
    await user.type(composer, '/线上bug排查');
    expect(await screen.findByRole('option', { name: /\/线上bug排查/ })).toBeInTheDocument();
  });

  it('keeps keyboard-highlighted slash command after ArrowDown keyup', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession('claude');
    const composer = screen.getByLabelText('发送到当前终端');

    await user.type(composer, '/');
    await screen.findByRole('option', { name: /\/help/ });
    await user.keyboard('{ArrowDown}{Enter}');

    expect(composer).toHaveValue('/clear');
    expect(terminalApi.writePty).not.toHaveBeenCalled();
  });

  it('scrolls the keyboard-highlighted suggestion into view at the list boundaries', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession('claude');
    const composer = screen.getByLabelText('发送到当前终端');

    await user.type(composer, '/');
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    scrollIntoView.mockClear();

    await user.keyboard('{ArrowDown}'.repeat(options.length - 1));
    await waitFor(() => expect(options[options.length - 1]).toHaveAttribute('aria-selected', 'true'));
    const callsAfterBottom = scrollIntoView.mock.calls.length;

    await user.keyboard('{ArrowUp}'.repeat(options.length - 1));
    await waitFor(() => expect(options[0]).toHaveAttribute('aria-selected', 'true'));

    expect(callsAfterBottom).toBeGreaterThan(0);
    expect(scrollIntoView.mock.calls.length).toBeGreaterThan(callsAfterBottom);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('closes slash command suggestions when clicking outside the composer and suggestion list', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession('claude');

    await user.type(screen.getByLabelText('发送到当前终端'), '/mod');
    expect(await screen.findByRole('option', { name: /\/model/ })).toBeInTheDocument();

    await user.click(screen.getByLabelText('AI 工作台'));

    expect(screen.queryByRole('option', { name: /\/model/ })).not.toBeInTheDocument();
  });

  it('shows all matching skill suggestions instead of truncating the slash list', async () => {
    vi.mocked(terminalApi.listAgentSkills).mockResolvedValue(
      Array.from({ length: 18 }, (_, index) => ({
        agent: 'claude',
        command: `/local-skill-${index + 1}`,
        description: `本地 Skill ${index + 1}`,
        name: `local-skill-${index + 1}`,
        path: `/tmp/local-skill-${index + 1}/SKILL.md`,
        source: 'Claude',
      })),
    );
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession('claude');

    await user.type(screen.getByLabelText('发送到当前终端'), '/local');

    expect(await screen.findByRole('option', { name: /\/local-skill-18/ })).toBeInTheDocument();
  });

  it('opens the composer skill panel and inserts a picked skill into the composer', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession('codex');
    const composer = screen.getByLabelText('发送到当前终端');

    await user.click(screen.getByRole('button', { name: 'Skill / Agent / 命令' }));
    await user.click(await screen.findByRole('button', { name: /\/env-resolver/ }));

    expect(composer).toHaveValue('/env-resolver ');
    expect(screen.queryByRole('region', { name: 'Skill 和命令列表' })).not.toBeInTheDocument();
  });

  it('opens the add-context menu from the composer plus button', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession();

    await user.click(screen.getByRole('button', { name: '添加上下文' }));

    expect(screen.getByRole('menuitem', { name: '插入当前文档' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '插入选中文档内容' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '插入路径' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '插入剪贴板' })).toBeInTheDocument();
  });

  it('inserts the current document from the add-context menu', async () => {
    vi.mocked(documentApi.readDocumentFile).mockResolvedValue({
      content: '# 方案\n正文',
      extension: 'md',
      name: '方案.md',
      path: 'docs/方案.md',
      size: 12,
    });
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession();
    window.localStorage.setItem('agentbox.document-panel-state.v1', JSON.stringify({ rootPath: '/tmp/project', selectedPath: 'docs/方案.md' }));

    await user.click(screen.getByRole('button', { name: '添加上下文' }));
    await user.click(screen.getByRole('menuitem', { name: '插入当前文档' }));

    expect(documentApi.readDocumentFile).toHaveBeenCalledWith('/tmp/project', 'docs/方案.md');
    await waitFor(() => expect(screen.getByLabelText('发送到当前终端')).toHaveValue('当前文档：docs/方案.md\n\n内容：\n# 方案\n正文'));
  });

  it('inserts a picked local path from the add-context menu', async () => {
    vi.mocked(documentApi.chooseDocumentFile).mockResolvedValue('/tmp/agentbox-skill/curl-test.zip');
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession();

    await user.click(screen.getByRole('button', { name: '添加上下文' }));
    await user.click(screen.getByRole('menuitem', { name: '插入路径' }));
    await user.click(screen.getByRole('button', { name: '选择文件' }));

    await waitFor(() => expect(screen.getByLabelText('发送到当前终端')).toHaveValue('/tmp/agentbox-skill/curl-test.zip'));
  });

  it('inserts clipboard text from the add-context menu', async () => {
    vi.mocked(terminalApi.getClipboardText).mockResolvedValue('剪贴板里的上下文');
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession();

    await user.click(screen.getByRole('button', { name: '添加上下文' }));
    await user.click(screen.getByRole('menuitem', { name: '插入剪贴板' }));

    await waitFor(() => expect(screen.getByLabelText('发送到当前终端')).toHaveValue('剪贴板内容：\n剪贴板里的上下文'));
  });

  it('fills the composer by clicking a prompt tool without sending to the terminal', async () => {
    render(
      <AiWorkspace
        features={[
          normalizeFeature({
            id: 'review-tool',
            name: '本地代码审查',
            description: '发送审查提示词',
            script: '请做代码审查',
            builtin: false,
            type: 'prompt',
          }),
        ]}
        onMessage={vi.fn()}
        prefs={{ favorites: [], order: ['review-tool'] }}
      />,
    );
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession();
    await showToolbox(user);

    expect(screen.queryByRole('button', { name: '填入输入框' })).not.toBeInTheDocument();
    await user.click(getFeatureHit(/本地代码审查/));

    expect(screen.getByLabelText('发送到当前终端')).toHaveValue('请做代码审查');
    expect(terminalApi.writePty).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(terminalApi.writePty).toHaveBeenCalledWith(expect.any(String), expect.any(String), '请做代码审查\r\n'));
  });

  it('appends inserted prompt text to the next line when the composer already has content', async () => {
    render(
      <AiWorkspace
        features={[
          normalizeFeature({
            id: 'review-tool',
            name: '本地代码审查',
            description: '发送审查提示词',
            script: '请做代码审查',
            builtin: false,
            type: 'prompt',
          }),
        ]}
        onMessage={vi.fn()}
        prefs={{ favorites: [], order: ['review-tool'] }}
      />,
    );
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession();
    const composer = screen.getByLabelText('发送到当前终端');
    await user.type(composer, '已有内容');
    await showToolbox(user);

    await user.click(getFeatureHit(/本地代码审查/));

    expect(composer).toHaveValue('已有内容\n请做代码审查');
  });

  it('inserts prompt text at the current composer cursor position', async () => {
    render(
      <AiWorkspace
        features={[
          normalizeFeature({
            id: 'review-tool',
            name: '本地代码审查',
            description: '发送审查提示词',
            script: '请做代码审查',
            builtin: false,
            type: 'prompt',
          }),
        ]}
        onMessage={vi.fn()}
        prefs={{ favorites: [], order: ['review-tool'] }}
      />,
    );
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession();
    const composer = screen.getByLabelText('发送到当前终端') as HTMLTextAreaElement;
    await user.type(composer, '前后');
    composer.setSelectionRange(1, 1);
    composer.dispatchEvent(new Event('select', { bubbles: true }));
    await showToolbox(user);

    await user.click(getFeatureHit(/本地代码审查/));

    expect(composer).toHaveValue('前请做代码审查后');
  });

  it('delegates non-composer tools to the app-level tool runner', async () => {
    const onToolInvoke = vi.fn();
    render(
      <AiWorkspace
        features={[
          normalizeFeature({
            id: 'builtin-json-format',
            name: 'JSON 格式化',
            description: '格式化 JSON',
            script: '',
            builtin: true,
            type: 'prompt',
          }),
        ]}
        onMessage={vi.fn()}
        onToolInvoke={onToolInvoke}
        prefs={{ favorites: [], order: ['builtin-json-format'] }}
      />,
    );
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = userEvent.setup();
    await showToolbox(user);

    await user.click(getFeatureHit(/JSON 格式化/));

    expect(onToolInvoke).toHaveBeenCalledWith(expect.objectContaining({ id: 'builtin-json-format' }), expect.any(Function));
  });

  it('renders all tool cards with the same card layout as the toolbox page', async () => {
    render(
      <AiWorkspace
        features={[
          normalizeFeature({
            id: 'review-tool',
            name: '本地代码审查',
            description: '发送审查提示词',
            script: '请做代码审查',
            builtin: false,
            type: 'prompt',
          }),
          normalizeFeature({
            id: 'snippet-tool',
            name: '服务瘦身上下文',
            description: '补充服务瘦身背景信息',
            script: '服务瘦身背景',
            builtin: false,
            type: 'snippet',
          }),
        ]}
        onMessage={vi.fn()}
        prefs={{ favorites: [], order: ['review-tool', 'snippet-tool'] }}
      />,
    );
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = userEvent.setup();
    await showToolbox(user);

    const reviewCard = getFeatureHit(/本地代码审查/);
    expect(reviewCard).toHaveClass('feature-hit');
    expect(reviewCard.closest('.feature-card')).toBeInTheDocument();
    expect(reviewCard.querySelector('.type-badge')).toHaveTextContent('提示词');
    expect(reviewCard.querySelector('strong')).toHaveTextContent('本地代码审查');
    expect(reviewCard.querySelector('span:last-child')).toHaveTextContent('发送审查提示词');
    expect(reviewCard.closest('.feature-card')?.querySelector('.feature-actions')).toBeInTheDocument();

    const snippetCard = getFeatureHit(/服务瘦身上下文/);
    expect(snippetCard).toHaveClass('feature-hit');
    expect(snippetCard.closest('.feature-card')).toBeInTheDocument();
    expect(snippetCard.querySelector('.type-badge')).toHaveTextContent('片段');
    expect(snippetCard.querySelector('strong')).toHaveTextContent('服务瘦身上下文');
    expect(snippetCard.querySelector('span:last-child')).toHaveTextContent('补充服务瘦身背景信息');
    expect(snippetCard.closest('.feature-card')?.querySelector('.feature-actions')).toBeInTheDocument();
  });

  it('marks the AI tool list as natural-height so filtered tags do not stretch sparse cards', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = userEvent.setup();
    await showToolbox(user);

    expect(screen.getByLabelText('AI 工具列表')).toHaveClass('natural-height-list');
  });

  it('shows document and toolbox dock buttons from top to bottom and switches panels', async () => {
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');

    const dock = screen.getByLabelText('右侧插件栏');
    expect(dock).toHaveClass('fixed-end-dock');
    expect(dock).toHaveClass('vertical-dock');
    expect(within(dock).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      '收起文档目录',
      '显示工具箱',
      '显示 Git 变更',
      '显示实时追踪',
    ]);
    expect(screen.getByText('文档目录')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '显示工具箱' }));
    expect(screen.getByText('工具列表')).toBeInTheDocument();
    expect(screen.queryByText('文档目录')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '收起工具箱' }));
    expect(screen.queryByText('工具列表')).not.toBeInTheDocument();
    expect(screen.getByLabelText('右侧插件栏')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '显示实时追踪' }));
    expect(screen.getByText('实时追踪')).toBeInTheDocument();
    expect(screen.queryByText('工具列表')).not.toBeInTheDocument();
  });

  it('collapses the session rail into a narrow bordered strip that can be expanded back', async () => {
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');

    const workspace = screen.getByLabelText('AI 工作台');
    await user.click(screen.getByRole('button', { name: '收起会话列表' }));

    expect(workspace).toHaveStyle('--session-rail-width: 40px');
    expect(screen.queryByRole('button', { name: '显示会话列表' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '展开会话列表' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '展开会话列表' }));

    expect(workspace).not.toHaveStyle('--session-rail-width: 40px');
    expect(screen.getByRole('button', { name: '收起会话列表' })).toBeInTheDocument();
  });

  it('keeps the plugin columns collapsed when the session rail is collapsed after closing the plugin', async () => {
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');

    await user.click(screen.getByRole('button', { name: '显示工具箱' }));
    await user.click(screen.getByRole('button', { name: '收起工具箱' }));
    await user.click(screen.getByRole('button', { name: '收起会话列表' }));

    const workspace = screen.getByLabelText('AI 工作台');
    expect(workspace).toHaveClass('tools-collapsed', 'sessions-collapsed');
    expect(stylesCss).toContain('.ai-workspace.tools-collapsed.sessions-collapsed');
  });


  it('lets the document side panel expand until it reaches the session rail', async () => {
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1200);
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');

    const workspace = screen.getByLabelText('AI 工作台');
    const divider = screen.getByRole('separator', { name: '调整工具列表宽度' });
    act(() => {
      dispatchPointer(divider, 'pointerdown', 900);
      dispatchPointer(window, 'pointermove', -500);
      dispatchPointer(window, 'pointermove', -1200);
      dispatchPointer(window, 'pointerup', 120);
    });

    expect(workspace).toHaveStyle('--tool-panel-width: 870px');
  });

  it('keeps the toolbox side panel resize capped at the original limit', async () => {
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600);
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    await user.click(screen.getByRole('button', { name: '显示工具箱' }));

    const workspace = screen.getByLabelText('AI 工作台');
    const divider = screen.getByRole('separator', { name: '调整工具列表宽度' });
    act(() => {
      dispatchPointer(divider, 'pointerdown', 900);
      dispatchPointer(window, 'pointermove', 120);
      dispatchPointer(window, 'pointerup', 120);
    });

    expect(workspace).toHaveStyle('--tool-panel-width: 620px');
  });

  it('caps the session rail before it pushes the central workbench off screen', async () => {
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1200);
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');

    const workspace = screen.getByLabelText('AI 工作台');
    const divider = screen.getByRole('separator', { name: '调整会话列表宽度' });
    act(() => {
      dispatchPointer(divider, 'pointerdown', 300);
      dispatchPointer(window, 'pointermove', 1200);
      dispatchPointer(window, 'pointerup', 1200);
    });

    expect(workspace).toHaveStyle('--session-rail-width: 370px');
  });

  it('renders PTY output event data directly without polling first', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');

    await createSession();
    const [sessionId, generation] = vi.mocked(terminalApi.startPty).mock.calls[0];
    vi.mocked(terminalApi.pollPty).mockClear();
    act(() => {
      outputHandler?.({ sessionId, generation, data: 'Claude ready' });
    });

    await waitFor(() => expect(screen.getByText(/Claude ready/)).toBeInTheDocument());
    expect(terminalApi.pollPty).not.toHaveBeenCalled();
  });

  it('keeps PTY output that arrives before React refs observe a new session', async () => {
    vi.mocked(terminalApi.startPty).mockImplementationOnce((sessionId, generation) => {
      outputHandler?.({ sessionId, generation, data: 'early boot text' });
      return Promise.resolve();
    });
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');

    await createSession();

    await waitFor(() => expect(screen.getByText(/early boot text/)).toBeInTheDocument());
  });

  it('keeps PTY output that arrives before React refs observe a resumed generation', async () => {
    loadAiWorkspace.mockResolvedValue(archive([persistedSession({ cliSessionId: '019f8565-e310-7f73-b003-8d5bf94a7982' })]));
    vi.mocked(terminalApi.startPty).mockImplementationOnce((sessionId, generation) => {
      outputHandler?.({ sessionId, generation, data: 'resume boot text' });
      return Promise.resolve();
    });
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '重新启动' }));

    await waitFor(() => expect(screen.getByText(/resume boot text/)).toBeInTheDocument());
  });

  it('keeps composer input when the active session is stopped', async () => {
    loadAiWorkspace.mockResolvedValue(archive([persistedSession()]));
    const onMessage = vi.fn();
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={onMessage} />);

    await user.type(await screen.findByLabelText('发送到当前终端'), '不要丢失');
    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(onMessage).toHaveBeenCalledWith('当前会话已停止，请先重新启动');
    expect(screen.getByLabelText('发送到当前终端')).toHaveValue('不要丢失');
  });

  it('keeps an unsent composer draft per session', async () => {
    loadAiWorkspace.mockResolvedValue(archive([
      persistedSession({ id: 'session-1', name: '会话一' }),
      persistedSession({ id: 'session-2', name: '会话二', updatedAt: 2 }),
    ]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    const composer = await screen.findByLabelText('发送到当前终端');
    await user.type(composer, '文本1');
    await user.click(screen.getByRole('button', { name: /会话二 已停止/ }));
    expect(screen.getByLabelText('发送到当前终端')).toHaveValue('');

    await user.type(screen.getByLabelText('发送到当前终端'), '文本2');
    await user.click(screen.getByRole('button', { name: /会话一 已停止/ }));
    expect(screen.getByLabelText('发送到当前终端')).toHaveValue('文本1');

    await user.click(screen.getByRole('button', { name: /会话二 已停止/ }));
    expect(screen.getByLabelText('发送到当前终端')).toHaveValue('文本2');
  });

  it('opens a feature window for a confirm sequence instead of filling the composer immediately', async () => {
    loadAiWorkspace.mockResolvedValue(groupedArchive([
      persistedSession({ id: 'session-1', name: '瘦身会话', groupId: 'group-1' }),
    ]));
    const user = userEvent.setup();
    render(
      <AiWorkspace
        features={[
          normalizeFeature({
            id: 'service-slim-workflow',
            name: '服务瘦身逐步检查',
            description: '逐步检查',
            script: '梳理入口\n@@@STEP@@@\n检查无入口方法',
            builtin: false,
            type: 'sequence',
            seqRule: 'confirm',
          }),
        ]}
        onMessage={vi.fn()}
        prefs={{ favorites: [], order: ['service-slim-workflow'] }}
      />,
    );

    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    await showToolbox(user);
    await user.click(getFeatureHit(/服务瘦身逐步检查/));
    await user.click(screen.getByRole('button', { name: '创建窗口' }));

    expect(screen.getByRole('complementary', { name: '功能窗口列表' })).toBeInTheDocument();
    expect(screen.getByText('绑定分组：服务瘦身')).toBeInTheDocument();
    expect(screen.getByLabelText('发送到当前终端')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: '执行步骤 1' }));

    expect(screen.getByLabelText('发送到当前终端')).toHaveValue('梳理入口');
  });

  it('prevents opening the same feature window twice in the same group', async () => {
    const onMessage = vi.fn();
    loadAiWorkspace.mockResolvedValue(groupedArchive([
      persistedSession({ id: 'session-1', name: '瘦身会话', groupId: 'group-1' }),
    ]));
    const user = userEvent.setup();
    render(
      <AiWorkspace
        features={[
          normalizeFeature({
            id: 'service-slim-workflow',
            name: '服务瘦身逐步检查',
            description: '逐步检查',
            script: '梳理入口\n@@@STEP@@@\n检查无入口方法',
            builtin: false,
            type: 'sequence',
            seqRule: 'confirm',
          }),
        ]}
        onMessage={onMessage}
        prefs={{ favorites: [], order: ['service-slim-workflow'] }}
      />,
    );

    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    await showToolbox(user);
    await user.click(getFeatureHit(/服务瘦身逐步检查/));
    await user.click(screen.getByRole('button', { name: '创建窗口' }));
    expect(screen.getAllByText('绑定分组：服务瘦身')).toHaveLength(1);

    await user.click(getFeatureHit(/服务瘦身逐步检查/));
    await user.click(screen.getByRole('button', { name: '创建窗口' }));

    expect(onMessage).toHaveBeenCalledWith('「服务瘦身逐步检查」在「服务瘦身」分组里已经打开，不能重复创建');
    expect(screen.getAllByText('绑定分组：服务瘦身')).toHaveLength(1);
  });

  it('toggles and restores feature window step completion by feature and group', async () => {
    loadAiWorkspace.mockResolvedValue({
      ...groupedArchive([
        persistedSession({ id: 'session-1', name: '瘦身会话', groupId: 'group-1' }),
      ]),
      featureWindowStates: [
        { featureId: 'service-slim-workflow', groupId: 'group-1', done: { 1: true }, updatedAt: 20 },
      ],
    });
    const user = userEvent.setup();
    render(
      <AiWorkspace
        features={[
          normalizeFeature({
            id: 'service-slim-workflow',
            name: '服务瘦身逐步检查',
            description: '逐步检查',
            script: '梳理入口\n@@@STEP@@@\n检查无入口方法',
            builtin: false,
            type: 'sequence',
            seqRule: 'confirm',
          }),
        ]}
        onMessage={vi.fn()}
        prefs={{ favorites: [], order: ['service-slim-workflow'] }}
      />,
    );

    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    await showToolbox(user);
    await user.click(getFeatureHit(/服务瘦身逐步检查/));
    await user.click(screen.getByRole('button', { name: '创建窗口' }));
    expect(screen.getByText('检查无入口方法').closest('.feature-window-step')).toHaveTextContent('完成');

    await user.click(screen.getByRole('button', { name: '取消完成步骤 2' }));
    expect(screen.getByText('检查无入口方法').closest('.feature-window-step')?.querySelector('.done-badge')).toBeNull();
    expect(screen.getByRole('button', { name: '完成步骤 2' })).toBeInTheDocument();

    await waitFor(() => expect(saveAiWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      featureWindowStates: expect.arrayContaining([
        expect.objectContaining({ featureId: 'service-slim-workflow', groupId: 'group-1', done: {} }),
      ]),
    })));

    await user.click(screen.getByRole('button', { name: '完成步骤 1' }));
    await user.click(screen.getByRole('button', { name: '关闭服务瘦身逐步检查' }));
    expect(screen.queryByRole('complementary', { name: '功能窗口列表' })).not.toBeInTheDocument();

    await user.click(getFeatureHit(/服务瘦身逐步检查/));
    await user.click(screen.getByRole('button', { name: '创建窗口' }));

    expect(screen.getByText('梳理入口').closest('.feature-window-step')).toHaveTextContent('完成');
  });

  it('renders an explicit resize handle and applies the default composer height', async () => {
    loadAiWorkspace.mockResolvedValue(archive([persistedSession()]));
    render(<AiWorkspace onMessage={vi.fn()} />);

    expect(await screen.findByRole('separator', { name: '调整输入框高度' })).toBeInTheDocument();
    expect(screen.getByLabelText('发送到当前终端')).toHaveStyle({ height: '72px' });
  });

  it('stops a running process before deleting the session', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession();

    await user.click(screen.getByRole('button', { name: 'claude session 会话操作' }));
    await user.click(screen.getByRole('menuitem', { name: '删除' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(terminalApi.stopPty).toHaveBeenCalledWith(expect.any(String), expect.any(String)));
    expect(screen.getByText('新建一个 Claude Code 或 Codex 会话')).toBeInTheDocument();
  });

  it('waits for a session startup before stopping and deleting it', async () => {
    const startup = deferred<void>();
    vi.mocked(terminalApi.startPty).mockReturnValueOnce(startup.promise);
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession();

    await user.click(screen.getByRole('button', { name: 'claude session 会话操作' }));
    await user.click(screen.getByRole('menuitem', { name: '删除' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));

    expect(terminalApi.stopPty).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /claude session 启动中/ })).toBeInTheDocument();

    startup.resolve();
    await waitFor(() => expect(terminalApi.stopPty).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('新建一个 Claude Code 或 Codex 会话')).toBeInTheDocument());
  });

  it('keeps a running session when stopping it before deletion fails', async () => {
    const onMessage = vi.fn();
    render(<AiWorkspace onMessage={onMessage} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession();
    vi.mocked(terminalApi.stopPty).mockRejectedValueOnce(new Error('停止失败'));

    await user.click(screen.getByRole('button', { name: 'claude session 会话操作' }));
    await user.click(screen.getByRole('menuitem', { name: '删除' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(onMessage).toHaveBeenCalledWith('停止失败'));
    expect(screen.getByRole('button', { name: 'claude session 运行中' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '删除会话' })).toBeInTheDocument();
  });

  it('preserves other session output received while deletion waits for stop', async () => {
    const stop = deferred<void>();
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    const user = await createSession('claude');
    await createSession('codex');
    const otherId = vi.mocked(terminalApi.startPty).mock.calls[0][0];
    vi.mocked(terminalApi.stopPty).mockReturnValueOnce(stop.promise);

    await user.click(screen.getByRole('button', { name: 'codex session 会话操作' }));
    await user.click(screen.getByRole('menuitem', { name: '删除' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(terminalApi.stopPty).toHaveBeenCalled());

    const otherGeneration = vi.mocked(terminalApi.startPty).mock.calls[0][1];
    vi.mocked(terminalApi.pollPty).mockResolvedValueOnce({ data: '删除期间的新输出', running: true });
    act(() => {
      outputHandler?.({ sessionId: otherId, generation: otherGeneration, data: '删除期间的新输出' });
    });
    stop.resolve();

    await waitFor(() => expect(screen.queryByRole('button', { name: /codex session/ })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId(`terminal-${otherId}`)).toHaveTextContent('删除期间的新输出'));
  });

  it('drains PTY output by polling when no output event is delivered', async () => {
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByText('新建一个 Claude Code 或 Codex 会话');
    await createSession();
    vi.mocked(terminalApi.pollPty).mockResolvedValueOnce({ data: 'poll fallback text', running: true });

    expect(await screen.findByText(/poll fallback text/, undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it('closes an open session menu when its trigger is clicked again', async () => {
    loadAiWorkspace.mockResolvedValue(archive([persistedSession()]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    const trigger = await screen.findByRole('button', { name: '历史会话 会话操作' });
    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.click(trigger);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('renames a session and persists the new name', async () => {
    loadAiWorkspace.mockResolvedValue(archive([persistedSession()]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '历史会话 会话操作' }));
    await user.click(screen.getByRole('menuitem', { name: '重命名' }));
    await user.clear(screen.getByLabelText('新会话名称'));
    await user.type(screen.getByLabelText('新会话名称'), '新会话名称');
    await user.click(screen.getByRole('button', { name: '保存名称' }));

    expect(screen.getByRole('button', { name: /新会话名称 已停止/ })).toBeInTheDocument();
    await waitFor(() => expect(saveAiWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ sessions: expect.arrayContaining([expect.objectContaining({ name: '新会话名称' })]) }),
    ));
  });

  it('pins a session ahead of newer unpinned sessions', async () => {
    loadAiWorkspace.mockResolvedValue(archive([
      persistedSession({ id: 'newer', name: '较新会话', updatedAt: 20 }),
      persistedSession({ id: 'older', name: '较旧会话', updatedAt: 10 }),
    ]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '较旧会话 会话操作' }));
    await user.click(screen.getByRole('menuitem', { name: '置顶' }));

    const sessionButtons = screen.getAllByRole('button', { name: /会话 已停止/ });
    expect(sessionButtons.map((button) => button.getAttribute('aria-label'))).toEqual([
      '较旧会话 已停止', '较新会话 已停止',
    ]);
  });

  it('persists a group pin change immediately', async () => {
    loadAiWorkspace.mockResolvedValue(groupedArchive());
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '服务瘦身分组操作' }));
    await user.click(screen.getByRole('menuitem', { name: '置顶' }));

    await waitFor(() => expect(saveAiWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      groups: expect.arrayContaining([
        expect.objectContaining({ id: 'group-1', pinned: true }),
      ]),
    })));
  });

  it('moves a group to deleted without removing histories and restores it from the filter', async () => {
    loadAiWorkspace.mockResolvedValue(groupedArchive([
      persistedSession({ id: 'group-session', name: '分组会话', groupId: 'group-1' }),
    ]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '服务瘦身分组操作' }));
    await user.click(screen.getByRole('menuitem', { name: '删除分组' }));
    await user.click(screen.getByRole('button', { name: '移入已删除' }));

    expect(commitAiSessionDeletion).not.toHaveBeenCalled();
    await waitFor(() => expect(saveAiWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      groups: [expect.objectContaining({ id: 'group-1', deletedAt: expect.any(Number) })],
      sessions: [expect.objectContaining({ id: 'group-session' })],
    })));
    await user.click(screen.getByRole('button', { name: '筛选会话分组' }));
    await user.click(within(screen.getByRole('listbox', { name: '筛选会话分组' })).getByRole('option', { name: '已删除' }));
    await user.click(screen.getByRole('button', { name: '恢复服务瘦身' }));
    await user.click(screen.getByRole('button', { name: '筛选会话分组' }));
    await user.click(within(screen.getByRole('listbox', { name: '筛选会话分组' })).getByRole('option', { name: '在使用' }));
    expect(screen.getByRole('heading', { level: 3, name: '服务瘦身' })).toBeInTheDocument();
  });

  it('keeps the session when delete confirmation is cancelled', async () => {
    loadAiWorkspace.mockResolvedValue(archive([persistedSession()]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '历史会话 会话操作' }));
    await user.click(screen.getByRole('menuitem', { name: '删除' }));
    await user.click(screen.getByRole('button', { name: '取消删除' }));

    expect(screen.getByRole('button', { name: /历史会话 已停止/ })).toBeInTheDocument();
    expect(terminalApi.stopPty).not.toHaveBeenCalled();
  });

  it('keeps the session list position when a session is restarted', async () => {
    loadAiWorkspace.mockResolvedValue(archive([
      persistedSession({ id: 'first', name: '第一会话', updatedAt: 10 }),
      persistedSession({ id: 'second', name: '第二会话', updatedAt: 20 }),
    ]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    expect((await screen.findAllByRole('button', { name: /会话 已停止/ })).map((button) => button.getAttribute('aria-label'))).toEqual([
      '第一会话 已停止',
      '第二会话 已停止',
    ]);

    await user.click(screen.getByRole('button', { name: '重新启动' }));

    expect(screen.getAllByRole('button', { name: /会话 (运行中|已停止)/ }).map((button) => button.getAttribute('aria-label'))).toEqual([
      '第一会话 运行中',
      '第二会话 已停止',
    ]);
  });

  it('clears the terminal and resumes the exact CLI session without deleting archive history', async () => {
    const cliSessionId = '019f8565-e310-7f73-b003-8d5bf94a7982';
    loadAiWorkspace.mockResolvedValue(archive([persistedSession({ cliSessionId })]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('terminal-session-1')).toHaveTextContent('clear-0:history'));
    await user.click(screen.getByRole('button', { name: '重新启动' }));

    expect(screen.getByTestId('terminal-session-1')).toHaveTextContent('clear-1:');
    expect(screen.getByTestId('terminal-session-1')).not.toHaveTextContent('clear-1:history');
    expect(terminalApi.startPty).toHaveBeenCalledWith(
      'session-1',
      expect.any(String),
      'claude',
      '/tmp',
      { cliSessionId, resume: true, fallbackResume: false, cols: 80, rows: 24 },
    );
  });

  it('recreates the terminal view before resuming a stopped session', async () => {
    const cliSessionId = '019f8565-e310-7f73-b003-8d5bf94a7982';
    loadAiWorkspace.mockResolvedValue(archive([persistedSession({ cliSessionId })]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    const terminal = await screen.findByTestId('terminal-session-1');
    const initialInstance = terminal.getAttribute('data-terminal-instance');
    await user.click(screen.getByRole('button', { name: '重新启动' }));

    await waitFor(() => expect(screen.getByTestId('terminal-session-1')).not.toHaveAttribute('data-terminal-instance', initialInstance));
  });

  it('keeps composer controls outside the editable textarea area', async () => {
    loadAiWorkspace.mockResolvedValue(archive([persistedSession()]));
    render(<AiWorkspace onMessage={vi.fn()} />);
    await screen.findByLabelText('发送到当前终端');

    const boxRule = stylesCss.match(/\.terminal-composer-box\s*\{([^}]*)\}/)?.[1] ?? '';
    const textareaRule = stylesCss.match(/\.terminal-composer textarea\s*\{([^}]*)\}/)?.[1] ?? '';
    const footerRule = stylesCss.match(/\.terminal-composer-footer\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(boxRule).toMatch(/display:\s*flex;/);
    expect(boxRule).toMatch(/flex-direction:\s*column;/);
    expect(footerRule).toMatch(/position:\s*static;/);
    expect(textareaRule).toMatch(/padding:\s*11px 12px 10px;/);
  });

  it('uses directory-scoped fallback for old records without a CLI session id', async () => {
    loadAiWorkspace.mockResolvedValue(archive([persistedSession()]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '重新启动' }));

    expect(terminalApi.startPty).toHaveBeenCalledWith(
      'session-1',
      expect.any(String),
      'claude',
      '/tmp',
      { cliSessionId: undefined, resume: true, fallbackResume: true, cols: 80, rows: 24 },
    );
  });

  it('does not restore a Codex session without an exact CLI session id', async () => {
    const onMessage = vi.fn();
    loadAiWorkspace.mockResolvedValue(archive([persistedSession({ agent: 'codex' })]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={onMessage} />);

    await user.click(await screen.findByRole('button', { name: '重新启动' }));

    expect(terminalApi.startPty).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining('该 Codex 会话没有捕获到 CLI session id'));
    expect(screen.getByText('会话恢复失败')).toBeInTheDocument();
    expect(screen.getByText(/相同目录直接重启并覆盖当前会话/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '在此重启新会话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /历史会话 异常/ })).toBeInTheDocument();
    expect(screen.getByLabelText('发送到当前终端')).toBeVisible();
  });

  it('restarts the same Codex session row from the recovery failure action', async () => {
    loadAiWorkspace.mockResolvedValue(archive([persistedSession({ agent: 'codex' })]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '重新启动' }));
    await screen.findByText('会话恢复失败');
    const failedInstance = screen.getByTestId('terminal-session-1').getAttribute('data-terminal-instance');
    await user.click(screen.getByRole('button', { name: '在此重启新会话' }));

    await waitFor(() => expect(screen.getByTestId('terminal-session-1')).not.toHaveAttribute('data-terminal-instance', failedInstance));
    expect(terminalApi.startPty).toHaveBeenCalledTimes(1);
    expect(terminalApi.startPty).toHaveBeenCalledWith(
      'session-1',
      expect.any(String),
      'codex',
      '/tmp',
      { cliSessionId: undefined, resume: false, fallbackResume: false, cols: 80, rows: 24 },
    );
    expect(await screen.findByRole('button', { name: /历史会话 运行中/ })).toBeInTheDocument();
  });

  it('recovers a Codex session id from local metadata before restarting', async () => {
    const cliSessionId = '019f8565-e310-7f73-b003-8d5bf94a7982';
    loadAiWorkspace.mockResolvedValue(archive([
      persistedSession({ agent: 'codex', createdAt: 10, updatedAt: 20 }),
    ]));
    vi.mocked(terminalApi.findAgentSessionId).mockResolvedValue(cliSessionId);
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '重新启动' }));

    await waitFor(() => expect(terminalApi.findAgentSessionId).toHaveBeenCalledWith('codex', '/tmp', 20));
    expect(terminalApi.startPty).toHaveBeenCalledWith(
      'session-1',
      expect.any(String),
      'codex',
      '/tmp',
      { cliSessionId, resume: true, fallbackResume: false, cols: 80, rows: 24 },
    );
  });

  it('shows a Claude recovery action when exact resume cannot find the conversation', async () => {
    const cliSessionId = 'd38c6b56-9973-4fd3-9e71-05dee2e0fd9f';
    loadAiWorkspace.mockResolvedValue(archive([
      persistedSession({ cliSessionId }),
    ]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '重新启动' }));
    const [sessionId, generation] = vi.mocked(terminalApi.startPty).mock.calls[0];

    act(() => {
      exitHandler?.({ sessionId, generation, error: `No conversation found with session ID: ${cliSessionId}` });
    });

    await waitFor(() => expect(screen.getByText('会话恢复失败')).toBeInTheDocument());
    expect(terminalApi.startPty).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/CLI 没有找到会话 ID/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '在此重启新会话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /历史会话 异常/ })).toBeInTheDocument();
  });

  it('restarts an empty Claude session as a fresh session in the same row', async () => {
    const cliSessionId = 'd38c6b56-9973-4fd3-9e71-05dee2e0fd9f';
    loadAiWorkspace.mockResolvedValue(archive([persistedSession({ cliSessionId, name: '空 Claude 会话' })]));
    loadAiSessionHistory.mockResolvedValue('');
    vi.mocked(terminalApi.agentSessionExists).mockResolvedValue(false);
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '重新启动' }));

    expect(terminalApi.startPty).toHaveBeenCalledWith(
      'session-1',
      expect.any(String),
      'claude',
      '/tmp',
      { cliSessionId: expect.not.stringMatching(new RegExp(`^${cliSessionId}$`)), resume: false, fallbackResume: false, cols: 80, rows: 24 },
    );
    expect(screen.getAllByRole('button', { name: /空 Claude 会话 运行中/ })).toHaveLength(1);
  });

  it('marks Claude resume as failed when the CLI prints no-conversation output', async () => {
    const cliSessionId = '15db3e27-7c39-43bc-b6f9-55b2a8bb490e';
    loadAiWorkspace.mockResolvedValue(archive([
      persistedSession({ cliSessionId }),
    ]));
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '重新启动' }));
    const [sessionId, generation] = vi.mocked(terminalApi.startPty).mock.calls[0];

    act(() => {
      outputHandler?.({ sessionId, generation, data: `No conversation found with session ID: ${cliSessionId}\r\n` });
      outputHandler?.({ sessionId, generation, data: 'Claude Code ready\r\n' });
    });

    expect(await screen.findByText('会话恢复失败')).toBeInTheDocument();
    expect(screen.getByText(/CLI 没有找到会话 ID/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '在此重启新会话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /历史会话 异常/ })).toBeInTheDocument();
  });

  it('shows a Claude recovery reason and starts a replacement session when resume startup fails', async () => {
    const cliSessionId = 'd38c6b56-9973-4fd3-9e71-05dee2e0fd9f';
    loadAiWorkspace.mockResolvedValue(archive([
      persistedSession({ cliSessionId }),
    ]));
    vi.mocked(terminalApi.startPty)
      .mockRejectedValueOnce(new Error(`No conversation found with session ID: ${cliSessionId}`))
      .mockResolvedValueOnce();
    const user = userEvent.setup();
    render(<AiWorkspace onMessage={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '重新启动' }));

    expect(await screen.findByText('会话恢复失败')).toBeInTheDocument();
    expect(screen.getByText(/CLI 没有找到会话 ID/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '在此重启新会话' }));

    expect(terminalApi.startPty).toHaveBeenLastCalledWith(
      'session-1',
      expect.any(String),
      'claude',
      '/tmp',
      { cliSessionId: expect.any(String), resume: false, fallbackResume: false, cols: 80, rows: 24 },
    );
    expect(await screen.findByRole('button', { name: /历史会话 运行中/ })).toBeInTheDocument();
  });
});
