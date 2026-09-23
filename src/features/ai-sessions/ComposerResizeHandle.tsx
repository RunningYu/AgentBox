import { GripHorizontal } from 'lucide-react';
import { useRef, type PointerEvent } from 'react';

const DEFAULT_HEIGHT = 72;
const MIN_HEIGHT = 48;
const MAX_VIEWPORT_RATIO = 0.4;

interface ComposerResizeHandleProps {
  height: number;
  onHeightChange: (height: number) => void;
}

interface DragState {
  height: number;
  pointerId: number;
  startY: number;
}

export function calculateComposerHeight(
  startHeight: number,
  startY: number,
  currentY: number,
  viewportHeight: number,
) {
  const maxHeight = Math.floor(viewportHeight * MAX_VIEWPORT_RATIO);
  return Math.min(maxHeight, Math.max(MIN_HEIGHT, startHeight + startY - currentY));
}

export function ComposerResizeHandle({ height, onHeightChange }: ComposerResizeHandleProps) {
  const dragRef = useRef<DragState | null>(null);

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    dragRef.current = { height, pointerId: event.pointerId, startY: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    document.body.classList.add('resizing-composer');
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    onHeightChange(calculateComposerHeight(drag.height, drag.startY, event.clientY, window.innerHeight));
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    document.body.classList.remove('resizing-composer');
  }

  return (
    <div
      aria-label="调整输入框高度"
      aria-orientation="horizontal"
      aria-valuemax={Math.floor(window.innerHeight * MAX_VIEWPORT_RATIO)}
      aria-valuemin={MIN_HEIGHT}
      aria-valuenow={height}
      className="composer-resize-handle"
      onDoubleClick={() => onHeightChange(DEFAULT_HEIGHT)}
      onLostPointerCapture={finishDrag}
      onPointerCancel={finishDrag}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={finishDrag}
      role="separator"
    >
      <GripHorizontal aria-hidden="true" size={17} />
    </div>
  );
}
