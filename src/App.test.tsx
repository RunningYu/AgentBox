import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { loadCustomFeatures, saveCustomFeatures } from './shared/promptpadStorage';
import { getCurrentWindow } from '@tauri-apps/api/window';

const invoke = vi.fn(async (..._args: unknown[]) => undefined);
let nativeCloseEventHandler: ((event: { preventDefault: () => void }) => void | Promise<void>) | undefined;
let customCloseEventHandler: (() => void) | undefined;
let customCloseListenOptions: unknown;
let pendingCloseRequest = false;
const preventClose = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => {
    if (args[0] === 'take_main_window_close_request') {
      const pending = pendingCloseRequest;
      pendingCloseRequest = false;
      return Promise.resolve(pending);
    }
    return invoke(...args);
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: () => void, options?: unknown) => {
    if (event === 'main-window-close-requested') {
      customCloseEventHandler = handler;
      customCloseListenOptions = options;
    }
    return () => undefined;
  }),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    onCloseRequested: vi.fn(async (handler: typeof nativeCloseEventHandler) => {
      nativeCloseEventHandler = handler;
      return () => undefined;
    }),
  })),
}));

vi.mock('./shared/promptpadStorage', () => ({
  loadAiWorkspace: vi.fn(async () => ({ version: 2, groups: [], sessions: [] })),
  saveAiWorkspace: vi.fn(),
  loadCustomFeatures: vi.fn(async () => []),
  loadPrefs: vi.fn(async () => ({ favorites: [], order: [] })),
  saveCustomFeatures: vi.fn(),
  savePrefs: vi.fn(),
}));

vi.mock('./features/toolbox/Toolbox', () => ({
  Toolbox: ({ onDelete }: { onDelete: (feature: unknown) => void }) => (
    <div data-testid="toolbox-workspace">
      工具箱内容
      <button
        onClick={() => onDelete({
          id: 'custom-delete',
          name: '待删除功能',
          description: '删除测试',
          script: 'delete me',
          extra: '',
          builtin: false,
          type: 'prompt',
          agent: 'claude',
          autoRun: false,
          seqRule: 'auto',
          seqTerm: 'plain',
        })}
        type="button"
      >
        请求删除功能
      </button>
    </div>
  ),
}));

vi.mock('./features/files/FileWorkspace', () => ({
  FileWorkspace: ({ onBack }: { onBack: () => void }) => (
    <div data-testid="file-workspace">
      File 页面内容
      <button onClick={onBack} type="button">返回 AI 工作台</button>
    </div>
  ),
}));

vi.mock('./features/ai-sessions/AiWorkspace', async () => {
  const React = await import('react');
  return {
    AiWorkspace: ({ onToolInvoke }: { onToolInvoke: (feature: unknown, insertText: (text: string) => void) => void }) => {
      const [composer, setComposer] = React.useState('');
      return (
        <div data-testid="ai-workspace">
          AI 会话内容
          <output data-testid="ai-composer">{composer}</output>
          <button
            onClick={() => onToolInvoke({
              id: 'builtin-promptpad',
              name: 'PromptPad',
              description: '浮动输入窗口',
              script: '',
              extra: '',
              builtin: true,
              type: 'prompt',
              agent: 'claude',
              autoRun: false,
              seqRule: 'auto',
              seqTerm: 'plain',
            }, setComposer)}
            type="button"
          >
            AI PromptPad
          </button>
          <button
            onClick={() => onToolInvoke({
              id: 'builtin-json-format',
              name: 'JSON 格式化',
              description: '格式化 JSON',
              script: '',
              extra: '',
              builtin: true,
              type: 'prompt',
              agent: 'claude',
              autoRun: false,
              seqRule: 'auto',
              seqTerm: 'plain',
            }, setComposer)}
            type="button"
          >
            AI JSON
          </button>
        </div>
      );
    },
  };
});

describe('App workspace navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentWindow).mockImplementation(() => ({
      onCloseRequested: vi.fn(async (handler: unknown) => {
        nativeCloseEventHandler = handler as typeof nativeCloseEventHandler;
        return () => undefined;
      }),
    } as unknown as ReturnType<typeof getCurrentWindow>));
    nativeCloseEventHandler = undefined;
    customCloseEventHandler = undefined;
    customCloseListenOptions = undefined;
    pendingCloseRequest = false;
    preventClose.mockClear();
  });

  it('still renders the app in a browser without the Tauri window runtime', async () => {
    vi.mocked(getCurrentWindow).mockImplementation(() => {
      throw new Error('Tauri runtime is unavailable');
    });
    vi.mocked(loadCustomFeatures).mockRejectedValueOnce(new Error('Cannot read properties of undefined (reading \'invoke\')'));

    render(<App />);

    expect(await screen.findByTestId('ai-workspace')).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Cannot read properties/ })).not.toBeInTheDocument();
    });
  });

  it('opens on AI workspace first and keeps the switcher ordered as AI, Agent, toolbox, File', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByTestId('ai-workspace')).toBeVisible();
    expect(screen.getByTestId('toolbox-workspace').parentElement).toHaveAttribute('hidden');
    expect(screen.getAllByRole('button', { name: /^(AI 工作台|Agent 中心|工具箱|File)$/ }).map((button) => button.textContent)).toEqual([
      'AI 工作台',
      'Agent 中心',
      '工具箱',
      'File',
    ]);

    await user.click(screen.getByRole('button', { name: '工具箱' }));
    expect(screen.getByTestId('toolbox-workspace')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'File' }));
    expect(screen.getByTestId('file-workspace')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'AI 工作台' }));
    expect(screen.getByTestId('ai-workspace')).toBeVisible();
  });

  it('opens PromptPad from the AI tool runner and writes the result to the AI composer', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'AI 工作台' }));
    await user.click(screen.getByRole('button', { name: 'AI PromptPad' }));
    await user.type(screen.getByPlaceholderText('输入提示词、命令或任意文本'), '帮我整理上下文');
    await user.click(screen.getByRole('button', { name: '仅粘贴' }));

    expect(screen.getByTestId('ai-composer')).toHaveTextContent('帮我整理上下文');
  });

  it('opens JSON formatter from the AI tool runner', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'AI 工作台' }));
    await user.click(screen.getByRole('button', { name: 'AI JSON' }));

    expect(screen.getByRole('region', { name: 'JSON 格式化' })).toBeInTheDocument();
  });

  it('opens the public AgentBox user guide from the header', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: '打开 AgentBox 使用文档' }));

    expect(invoke).toHaveBeenCalledWith('open_external_url', {
      url: 'https://juejin.cn/spost/7686174631262453801',
    });
  });

  it('requires confirmation before deleting a custom feature', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: '工具箱' }));
    await user.click(await screen.findByRole('button', { name: '请求删除功能' }));

    expect(screen.getByRole('dialog', { name: '删除功能' })).toBeInTheDocument();
    expect(saveCustomFeatures).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认删除' }));

    expect(saveCustomFeatures).toHaveBeenCalledWith([]);
  });

  it('asks whether to hide or quit when the native close event arrives', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByTestId('ai-workspace');
    await act(async () => {
      await nativeCloseEventHandler?.({ preventDefault: preventClose });
    });

    expect(preventClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: '关闭 AgentBox' })).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('exit_app');

    await user.click(screen.getByRole('button', { name: '收起 App' }));

    expect(invoke).toHaveBeenCalledWith('hide_main_window');
    expect(screen.queryByRole('dialog', { name: '关闭 AgentBox' })).not.toBeInTheDocument();
  });

  it('registers the close request event for the main window', async () => {
    render(<App />);

    await screen.findByTestId('ai-workspace');

    expect(customCloseListenOptions).toEqual({ target: 'main' });
  });

  it('shows the close dialog when the backend close request is consumed by polling', async () => {
    vi.useFakeTimers();
    try {
      pendingCloseRequest = true;
      render(<App />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      expect(screen.getByRole('dialog', { name: '关闭 AgentBox' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('quits the app when the close dialog is confirmed', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByTestId('ai-workspace');
    await act(async () => {
      await nativeCloseEventHandler?.({ preventDefault: preventClose });
    });
    await user.click(screen.getByRole('button', { name: '关闭退出 App' }));

    expect(invoke).toHaveBeenCalledWith('exit_app');
  });
});
