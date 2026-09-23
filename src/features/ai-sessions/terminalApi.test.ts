import { beforeEach, describe, expect, it, vi } from 'vitest';

const { channels, invoke } = vi.hoisted(() => ({
  channels: [] as Array<{ onmessage?: (event: unknown) => void }>,
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage?: (event: unknown) => void;

    constructor() {
      channels.push(this);
    }
  },
  invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { startPty, subscribePtyChannel } from './terminalApi';

describe('terminalApi PTY channel', () => {
  beforeEach(() => {
    channels.length = 0;
    invoke.mockReset().mockResolvedValue(undefined);
  });

  it('streams output and exit events through a session-specific Tauri channel', async () => {
    const onOutput = vi.fn();
    const onExit = vi.fn();
    const unsubscribe = subscribePtyChannel(onOutput, onExit);

    await startPty('session-1', 'generation-1', 'codex', '/tmp');

    expect(invoke).toHaveBeenCalledWith('start_pty', expect.objectContaining({
      onEvent: channels[0],
      sessionId: 'session-1',
      generation: 'generation-1',
    }));
    channels[0].onmessage?.({ kind: 'output', sessionId: 'session-1', generation: 'generation-1', data: 'ready' });
    channels[0].onmessage?.({ kind: 'exit', sessionId: 'session-1', generation: 'generation-1', error: null });

    expect(onOutput).toHaveBeenCalledWith({ sessionId: 'session-1', generation: 'generation-1', data: 'ready' });
    expect(onExit).toHaveBeenCalledWith({ sessionId: 'session-1', generation: 'generation-1', error: null });
    unsubscribe();
  });

  it('passes the configured model to the Tauri PTY command', async () => {
    await startPty('session-1', 'generation-1', 'codex', '/tmp', { model: 'gpt-5.5' });

    expect(invoke).toHaveBeenCalledWith('start_pty', expect.objectContaining({
      model: 'gpt-5.5',
    }));
  });
});
