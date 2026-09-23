import { describe, expect, it } from 'vitest';
import { PtyHistoryBuffer } from './ptyHistoryBuffer';

describe('PtyHistoryBuffer', () => {
  it('stores output as chunks and joins it only when drained', () => {
    const buffer = new PtyHistoryBuffer();

    buffer.push('session-1', 'a');
    buffer.push('session-1', '\u007f');
    buffer.push('session-1', 'b');
    buffer.push('session-2', 'ready');

    expect(buffer.drain()).toEqual(new Map([
      ['session-1', 'a\u007fb'],
      ['session-2', 'ready'],
    ]));
    expect(buffer.drain().size).toBe(0);
  });

  it('drops buffered output for a deleted session', () => {
    const buffer = new PtyHistoryBuffer();
    buffer.push('deleted', 'stale');
    buffer.push('kept', 'ready');

    buffer.delete('deleted');

    expect(buffer.drain()).toEqual(new Map([['kept', 'ready']]));
  });
});
