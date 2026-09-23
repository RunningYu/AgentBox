import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { terminalTheme } from './terminalTheme';
import { TerminalView } from './TerminalView';
import { writePty } from './terminalApi';
import { writeTerminalOutput } from './terminalOutputBus';

let customKeyHandler: ((event: KeyboardEvent) => boolean) | undefined;
let dataHandler: ((data: string) => void) | undefined;
let terminalTextarea: HTMLTextAreaElement;
const disposeInput = vi.fn();
const disposeTerminal = vi.fn();
const fit = vi.fn();
const loadAddon = vi.fn();
const onData = vi.fn((handler: (data: string) => void) => {
  dataHandler = handler;
  return { dispose: disposeInput };
});
const open = vi.fn();
const write = vi.fn();
let terminalOptions: Record<string, unknown> | undefined;

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation((options) => {
    terminalOptions = options;
    return ({
    cols: 80,
    rows: 24,
    dispose: disposeTerminal,
    loadAddon,
    onData,
    open,
    reset: vi.fn(),
    get textarea() {
      return terminalTextarea;
    },
    write,
    attachCustomKeyEventHandler: vi.fn((handler) => {
      customKeyHandler = handler;
    }),
  });
  }),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({ fit })),
}));

vi.mock('./terminalApi', () => ({
  resizePty: vi.fn().mockResolvedValue(undefined),
  writePty: vi.fn().mockResolvedValue(undefined),
}));

class ResizeObserverMock {
  observe = vi.fn();
  disconnect = vi.fn();
}

describe('TerminalView', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    customKeyHandler = undefined;
    dataHandler = undefined;
    terminalOptions = undefined;
    terminalTextarea = document.createElement('textarea');
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  });

  it('defines ANSI colors instead of rendering everything with the default foreground', () => {
    expect(terminalTheme.foreground).toBe('#d7d7d7');
    expect(terminalTheme.red).toBeTruthy();
    expect(terminalTheme.green).toBeTruthy();
    expect(terminalTheme.blue).toBeTruthy();
    expect(terminalTheme.brightYellow).toBeTruthy();
  });

  it('fits the terminal before replaying TUI history without rewriting PTY newlines', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    render(
      <TerminalView
        active
        clearVersion={0}
        generation="generation-1"
        history="saved tui"
        onError={vi.fn()}
        sessionId="session-1"
      />,
    );

    expect(fit.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
    expect(terminalOptions).toMatchObject({ convertEol: false, reflowCursorLine: false });
    expect(write).toHaveBeenCalledWith('saved tui');
    width.mockRestore();
    height.mockRestore();
  });

  it('does not replay saved TUI history when a live PTY owns the screen', () => {
    render(
      <TerminalView
        active
        clearVersion={0}
        generation="generation-1"
        history="saved redraw stream"
        onError={vi.fn()}
        replayHistory={false}
        sessionId="session-1"
      />,
    );

    expect(write).not.toHaveBeenCalledWith('saved redraw stream');
  });

  it('refits when the composer changes the available terminal height', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    const view = render(
      <TerminalView
        active
        clearVersion={0}
        generation="generation-1"
        history=""
        layoutHeight={72}
        onError={vi.fn()}
        sessionId="session-1"
      />,
    );
    await waitFor(() => expect(fit).toHaveBeenCalled());
    const before = fit.mock.calls.length;

    view.rerender(
      <TerminalView
        active
        clearVersion={0}
        generation="generation-1"
        history=""
        layoutHeight={240}
        onError={vi.fn()}
        sessionId="session-1"
      />,
    );

    await waitFor(() => expect(fit.mock.calls.length).toBeGreaterThan(before));
    width.mockRestore();
    height.mockRestore();
  });

  it('sends a modified newline sequence for Shift+Enter in the terminal', async () => {
    render(
      <TerminalView
        active
        clearVersion={0}
        generation="generation-1"
        history=""
        onError={vi.fn()}
        sessionId="session-1"
      />,
    );

    await waitFor(() => expect(customKeyHandler).toBeTypeOf('function'));
    const handledByXterm = customKeyHandler?.(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));

    expect(handledByXterm).toBe(false);
    await waitFor(() => expect(writePty).toHaveBeenCalledWith('session-1', 'generation-1', '\u001b[13;2u'));
  });

  it('captures Shift+Enter from the underlying textarea before xterm processes it', async () => {
    render(
      <TerminalView
        active
        clearVersion={0}
        generation="generation-1"
        history=""
        onError={vi.fn()}
        sessionId="session-1"
      />,
    );

    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', shiftKey: true });
    terminalTextarea.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(writePty).toHaveBeenCalledWith('session-1', 'generation-1', '\u001b[13;2u'));
  });

  it('writes active PTY output directly without waiting for React history props', async () => {
    render(
      <TerminalView
        active
        clearVersion={0}
        generation="generation-1"
        history=""
        onError={vi.fn()}
        sessionId="session-1"
      />,
    );

    expect(writeTerminalOutput('session-1', 'ready')).toBe(true);

    expect(write).toHaveBeenCalledWith('ready');
  });

  it('does not replay output when the matching history prop arrives after direct xterm output', async () => {
    const view = render(
      <TerminalView
        active
        clearVersion={0}
        generation="generation-1"
        history=""
        onError={vi.fn()}
        sessionId="session-1"
      />,
    );

    expect(writeTerminalOutput('session-1', 'ready')).toBe(true);
    view.rerender(
      <TerminalView
        active
        clearVersion={0}
        generation="generation-1"
        history="ready"
        onError={vi.fn()}
        sessionId="session-1"
      />,
    );
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenCalledWith('ready');
  });

  it('does not replace live output with an older history prop during startup', async () => {
    const view = render(
      <TerminalView
        active
        clearVersion={0}
        generation="generation-1"
        history="old history"
        onError={vi.fn()}
        sessionId="session-1"
      />,
    );

    write.mockClear();
    expect(writeTerminalOutput('session-1', 'new output')).toBe(true);
    view.rerender(
      <TerminalView
        active
        clearVersion={0}
        generation="generation-1"
        history="old history"
        onError={vi.fn()}
        sessionId="session-1"
      />,
    );
    await Promise.resolve();
    expect(write).toHaveBeenCalledWith('new output');
    expect(write).not.toHaveBeenCalledWith('old history');
  });

  it('preserves key order and coalesces input while a previous IPC write is pending', async () => {
    let resolveFirstWrite: (() => void) | undefined;
    vi.mocked(writePty).mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveFirstWrite = resolve;
    }));

    render(
      <TerminalView
        active
        clearVersion={0}
        generation="generation-1"
        history=""
        onError={vi.fn()}
        sessionId="session-1"
      />,
    );

    await waitFor(() => expect(dataHandler).toBeTypeOf('function'));
    dataHandler?.('a');
    await waitFor(() => expect(writePty).toHaveBeenCalledTimes(1));
    expect(writePty).toHaveBeenNthCalledWith(1, 'session-1', 'generation-1', 'a');

    dataHandler?.('\u007f');
    dataHandler?.('b');
    await Promise.resolve();
    expect(writePty).toHaveBeenCalledTimes(1);

    resolveFirstWrite?.();
    await waitFor(() => expect(writePty).toHaveBeenCalledTimes(2));
    expect(writePty).toHaveBeenNthCalledWith(2, 'session-1', 'generation-1', '\u007fb');
  });

  it('coalesces terminal input produced in the same event loop turn', async () => {
    render(
      <TerminalView
        active
        clearVersion={0}
        generation="generation-1"
        history=""
        onError={vi.fn()}
        sessionId="session-1"
      />,
    );

    await waitFor(() => expect(dataHandler).toBeTypeOf('function'));
    dataHandler?.('a');
    dataHandler?.('b');
    dataHandler?.('c');

    await waitFor(() => expect(writePty).toHaveBeenCalledTimes(1));
    expect(writePty).toHaveBeenNthCalledWith(1, 'session-1', 'generation-1', 'abc');
  });
});
