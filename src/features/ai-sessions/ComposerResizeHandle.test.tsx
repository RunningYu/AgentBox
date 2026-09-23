import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { calculateComposerHeight, ComposerResizeHandle } from './ComposerResizeHandle';

class TestPointerEvent extends MouseEvent {
  pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

globalThis.PointerEvent = TestPointerEvent as typeof PointerEvent;

describe('ComposerResizeHandle', () => {
  it('grows upward and shrinks downward within viewport bounds', () => {
    expect(calculateComposerHeight(72, 300, 220, 800)).toBe(152);
    expect(calculateComposerHeight(72, 300, 500, 800)).toBe(48);
    expect(calculateComposerHeight(300, 300, 0, 800)).toBe(320);
  });

  it('updates height while dragging and resets on double click', () => {
    const onHeightChange = vi.fn();
    render(<ComposerResizeHandle height={72} onHeightChange={onHeightChange} />);
    const handle = screen.getByRole('separator', { name: '调整输入框高度' });

    fireEvent.pointerDown(handle, { clientY: 300, pointerId: 7 });
    fireEvent.pointerMove(handle, { clientY: 220, pointerId: 7 });
    expect(onHeightChange).toHaveBeenCalledWith(152);

    fireEvent.doubleClick(handle);
    expect(onHeightChange).toHaveBeenLastCalledWith(72);
  });
});
