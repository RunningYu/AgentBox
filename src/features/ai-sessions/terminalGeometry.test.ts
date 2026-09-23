import { describe, expect, it } from 'vitest';
import { reportTerminalGeometry, waitForTerminalGeometry } from './terminalGeometry';

describe('terminal geometry', () => {
  it('starts a waiting PTY with the first measured terminal dimensions', async () => {
    const pending = waitForTerminalGeometry('new-session');
    reportTerminalGeometry('new-session', { cols: 143.9, rows: 51.2 });

    await expect(pending).resolves.toEqual({ cols: 143, rows: 51 });
    await expect(waitForTerminalGeometry('new-session')).resolves.toEqual({ cols: 143, rows: 51 });
  });

  it('falls back instead of leaving session startup blocked when the view cannot be measured', async () => {
    const result = waitForTerminalGeometry('hidden-session');
    await expect(result).resolves.toEqual({ cols: 80, rows: 24 });
  });
});
