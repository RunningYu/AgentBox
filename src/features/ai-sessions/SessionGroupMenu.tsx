import { Pencil, Pin, Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface SessionGroupMenuProps {
  anchorRect?: Pick<DOMRect, 'bottom' | 'right' | 'top'>;
  onClose: () => void;
  onDelete: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  pinned?: boolean;
}

export function useMenuBehavior(onClose: () => void) {
  const menuRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef(true);
  const triggerRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    items()[0]?.focus();

    function closeAndRestore() {
      restoreFocusRef.current = true;
      onClose();
    }
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) closeAndRestore();
    }
    function handleKeyDown(event: KeyboardEvent) {
      const menuItems = items();
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAndRestore();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || menuItems.length === 0) return;
      event.preventDefault();
      const currentIndex = menuItems.indexOf(document.activeElement as HTMLElement);
      if (event.key === 'Home') menuItems[0].focus();
      if (event.key === 'End') menuItems[menuItems.length - 1].focus();
      if (event.key === 'ArrowDown') menuItems[(currentIndex + 1 + menuItems.length) % menuItems.length].focus();
      if (event.key === 'ArrowUp') menuItems[(currentIndex - 1 + menuItems.length) % menuItems.length].focus();
    }
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', closeAndRestore, true);
    window.addEventListener('resize', closeAndRestore);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', closeAndRestore, true);
      window.removeEventListener('resize', closeAndRestore);
      if (restoreFocusRef.current && triggerRef.current?.isConnected) triggerRef.current.focus();
    };
  }, [onClose]);

  function run(action: () => void) {
    restoreFocusRef.current = false;
    action();
    onClose();
  }

  return { menuRef, run };
}

export function SessionGroupMenu({ anchorRect, onClose, onDelete, onRename, onTogglePin, pinned }: SessionGroupMenuProps) {
  const { menuRef, run } = useMenuBehavior(onClose);

  return createPortal(
    <div className="session-item-menu" ref={menuRef} role="menu" style={menuPosition(anchorRect)}>
      <button onClick={() => run(onTogglePin)} role="menuitem" type="button"><Pin size={15} />{pinned ? '取消置顶' : '置顶'}</button>
      <button onClick={() => run(onRename)} role="menuitem" type="button"><Pencil size={15} />重命名</button>
      <button className="danger" onClick={() => run(onDelete)} role="menuitem" type="button"><Trash2 size={15} />删除分组</button>
    </div>,
    document.body,
  );
}

function menuPosition(anchorRect?: Pick<DOMRect, 'bottom' | 'right' | 'top'>) {
  const margin = 8;
  const gap = 4;
  const width = 144;
  const height = 112;
  if (!anchorRect) return { left: margin, top: margin };
  const top = window.innerHeight - anchorRect.bottom - margin >= height
    ? anchorRect.bottom + gap
    : Math.max(margin, anchorRect.top - height - gap);
  const left = Math.min(
    Math.max(margin, anchorRect.right - width),
    Math.max(margin, window.innerWidth - width - margin),
  );
  return { left, top };
}
