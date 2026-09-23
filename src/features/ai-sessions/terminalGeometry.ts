export interface TerminalGeometry {
  cols: number;
  rows: number;
}

const latest = new Map<string, TerminalGeometry>();
const waiters = new Map<string, Array<(geometry: TerminalGeometry) => void>>();

export function reportTerminalGeometry(sessionId: string, geometry: TerminalGeometry): void {
  const normalized = {
    cols: Math.max(1, Math.floor(geometry.cols)),
    rows: Math.max(1, Math.floor(geometry.rows)),
  };
  latest.set(sessionId, normalized);
  const pending = waiters.get(sessionId);
  if (!pending) {
    return;
  }
  waiters.delete(sessionId);
  for (const resolve of pending) {
    resolve(normalized);
  }
}

export function waitForTerminalGeometry(sessionId: string): Promise<TerminalGeometry> {
  const existing = latest.get(sessionId);
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (geometry: TerminalGeometry) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const pending = waiters.get(sessionId)?.filter((waiter) => waiter !== finish);
      if (pending?.length) {
        waiters.set(sessionId, pending);
      } else {
        waiters.delete(sessionId);
      }
      resolve(geometry);
    };
    const pending = waiters.get(sessionId) ?? [];
    pending.push(finish);
    waiters.set(sessionId, pending);
    timer = setTimeout(() => finish({ cols: 80, rows: 24 }), 500);
  });
}
