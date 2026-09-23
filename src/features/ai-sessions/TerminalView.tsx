import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import {
  resizePty,
  writePty,
} from './terminalApi';
import { registerTerminalOutputWriter } from './terminalOutputBus';
import { reportTerminalGeometry } from './terminalGeometry';
import { MAX_HISTORY_LENGTH } from './sessionModel';
import { terminalTheme } from './terminalTheme';

const SHIFT_ENTER_SEQUENCE = '\u001b[13;2u';

interface TerminalViewProps {
  active: boolean;
  clearVersion: number;
  generation?: string;
  history: string;
  layoutHeight?: number;
  onError: (message: string) => void;
  replayHistory?: boolean;
  sessionId: string;
}

export function TerminalView({ active, clearVersion, generation, history, layoutHeight, onError, replayHistory = true, sessionId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const generationRef = useRef(generation);
  const historyRef = useRef(history);
  const onErrorRef = useRef(onError);
  const terminalRef = useRef<Terminal | null>(null);
  const clearVersionRef = useRef(clearVersion);
  const scheduleFitRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    generationRef.current = generation;
  }, [generation]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || history === historyRef.current) {
      return;
    }
    if (!replayHistory) {
      // A running PTY is the source of truth for its current screen. Its saved
      // history is a redraw stream and must not be replayed into a new xterm.
      historyRef.current = history;
      return;
    }
    // 实时 PTY 已经写入 xterm 时，React 传入的历史可能只是旧快照；不能用旧快照覆盖屏幕。
    if (historyRef.current.startsWith(history)) {
      return;
    }
    if (history.startsWith(historyRef.current)) {
      terminal.write(history.slice(historyRef.current.length));
    } else {
      terminal.reset();
      terminal.write(history);
    }
    historyRef.current = history;
  }, [history, replayHistory]);

  useEffect(() => {
    if (clearVersion === clearVersionRef.current) {
      return;
    }
    clearVersionRef.current = clearVersion;
    terminalRef.current?.reset();
    historyRef.current = history;
  }, [clearVersion, history]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      reflowCursorLine: false,
      scrollback: 10_000,
      theme: terminalTheme,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;

    const fitAndResize = () => {
      if (!container.isConnected || container.clientWidth === 0 || container.clientHeight === 0) {
        return;
      }
      fitAddon.fit();
      reportTerminalGeometry(sessionId, { cols: terminal.cols, rows: terminal.rows });
      const currentGeneration = generationRef.current;
      if (currentGeneration !== undefined) {
        void resizePty(sessionId, currentGeneration, terminal.cols, terminal.rows).catch(() => undefined);
      }
    };
    let fitFrame: number | null = null;
    const scheduleFit = () => {
      if (fitFrame !== null) {
        return;
      }
      fitFrame = requestAnimationFrame(() => {
        fitFrame = null;
        fitAndResize();
      });
    };
    scheduleFitRef.current = scheduleFit;

    // History contains cursor-relative TUI drawing. It must be parsed at the final geometry,
    // otherwise the initial 80x24 buffer reflows old prompt/status frames into scrollback.
    fitAndResize();
    if (replayHistory && historyRef.current) {
      terminal.write(historyRef.current);
    }

    let disposed = false;
    let queuedGeneration: string | undefined;
    let queuedInput = '';
    let flushScheduled = false;
    let writeInFlight = false;

    const scheduleFlush = () => {
      if (flushScheduled || writeInFlight || disposed || !queuedInput) {
        return;
      }
      flushScheduled = true;
      queueMicrotask(flushInput);
    };

    function flushInput() {
      flushScheduled = false;
      if (disposed || writeInFlight || !queuedInput || queuedGeneration === undefined) {
        return;
      }
      const data = queuedInput;
      const inputGeneration = queuedGeneration;
      queuedInput = '';
      queuedGeneration = undefined;
      writeInFlight = true;
      void writePty(sessionId, inputGeneration, data)
        .catch((error) => {
          if (!disposed) {
            onErrorRef.current(error instanceof Error ? error.message : String(error));
          }
        })
        .finally(() => {
          writeInFlight = false;
          scheduleFlush();
        });
    }
    const sendInput = (data: string) => {
      const currentGeneration = generationRef.current;
      if (currentGeneration === undefined || !data) {
        return;
      }
      if (queuedGeneration !== undefined && queuedGeneration !== currentGeneration) {
        queuedInput = '';
      }
      queuedGeneration = currentGeneration;
      queuedInput += data;
      scheduleFlush();
    };
    const sendShiftEnter = (event: KeyboardEvent) => {
      if (!isShiftEnter(event)) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      sendInput(SHIFT_ENTER_SEQUENCE);
      return true;
    };

    terminal.attachCustomKeyEventHandler((event) => {
      if (!sendShiftEnter(event)) {
        return true;
      }
      return false;
    });
    terminal.textarea?.addEventListener('keydown', sendShiftEnter, { capture: true });

    const inputDisposable = terminal.onData((data) => {
      sendInput(data);
    });

    const unregisterOutputWriter = registerTerminalOutputWriter(sessionId, (data) => {
      terminal.write(data);
      historyRef.current = `${historyRef.current}${data}`.slice(-MAX_HISTORY_LENGTH);
    });

    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(container);
    scheduleFit();

    return () => {
      disposed = true;
      queuedInput = '';
      flushScheduled = false;
      resizeObserver.disconnect();
      if (fitFrame !== null) {
        cancelAnimationFrame(fitFrame);
      }
      scheduleFitRef.current = () => undefined;
      terminal.textarea?.removeEventListener('keydown', sendShiftEnter, { capture: true });
      unregisterOutputWriter();
      inputDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!active) {
      return;
    }
    scheduleFitRef.current();
  }, [active, layoutHeight]);

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => containerRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus());
    }
  }, [active]);

  return <div className="terminal-view" ref={containerRef} />;
}

function isShiftEnter(event: KeyboardEvent): boolean {
  return event.type === 'keydown' &&
    event.shiftKey &&
    (event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter' || event.keyCode === 13);
}
