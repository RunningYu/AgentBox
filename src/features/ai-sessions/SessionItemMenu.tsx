import { Copy, FolderInput, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useMenuBehavior } from './SessionGroupMenu';

interface SessionItemMenuProps {
  anchorRect?: Pick<DOMRect, 'bottom' | 'right' | 'top'>;
  pinned: boolean;
  onClose: () => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  onMove?: () => void;
  onRename: () => void;
  onTogglePin: () => void;
}

export function SessionItemMenu({ anchorRect, pinned, onClose, onDelete, onDuplicate, onMove, onRename, onTogglePin }: SessionItemMenuProps) {
  const { menuRef, run } = useMenuBehavior(onClose);

  return createPortal(
    <div className="session-item-menu" ref={menuRef} role="menu" style={menuPosition(anchorRect, Boolean(onMove), Boolean(onDuplicate))}>
      <button onClick={() => run(onRename)} role="menuitem" type="button"><Pencil size={15} />重命名</button>
      {onDuplicate && <button onClick={() => run(onDuplicate)} role="menuitem" type="button"><Copy size={15} />复制会话</button>}
      <button onClick={() => run(onTogglePin)} role="menuitem" type="button">
        {pinned ? <PinOff size={15} /> : <Pin size={15} />}
        {pinned ? '取消置顶' : '置顶'}
      </button>
      {onMove && <button onClick={() => run(onMove)} role="menuitem" type="button"><FolderInput size={15} />移动到分组</button>}
      <button className="danger" onClick={() => run(onDelete)} role="menuitem" type="button"><Trash2 size={15} />删除</button>
    </div>,
    document.body,
  );
}

function menuPosition(anchorRect: Pick<DOMRect, 'bottom' | 'right' | 'top'> | undefined, hasMove: boolean, hasDuplicate: boolean) {
  const margin = 8;
  const gap = 4;
  const width = 144;
  const height = 12 + (3 + Number(hasMove) + Number(hasDuplicate)) * 32;
  if (!anchorRect) {
    return { left: margin, top: margin };
  }
  const spaceBelow = window.innerHeight - anchorRect.bottom - margin;
  const top = spaceBelow >= height
    ? anchorRect.bottom + gap
    : Math.max(margin, anchorRect.top - height - gap);
  const left = Math.min(
    Math.max(margin, anchorRect.right - width),
    Math.max(margin, window.innerWidth - width - margin),
  );
  return { left, top };
}
