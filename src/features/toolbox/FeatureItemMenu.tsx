import { Edit3, MoreVertical, Pin, Play, Star, StarOff, Trash2 } from 'lucide-react';
import { useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useMenuBehavior } from '../ai-sessions/SessionGroupMenu';

interface FeatureItemMenuProps {
  anchorRect?: Pick<DOMRect, 'bottom' | 'right' | 'top'>;
  builtin: boolean;
  favorite: boolean;
  onClose: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
  onInvoke: () => void;
  onPin: () => void;
  onToggleFavorite: () => void;
}

export function FeatureMenuTrigger({ label, onOpen }: { label: string; onOpen: (rect: DOMRect) => void }) {
  return (
    <button
      aria-haspopup="menu"
      aria-label={label}
      className="icon-button feature-menu-trigger"
      onClick={(event) => onOpen(event.currentTarget.getBoundingClientRect())}
      title="更多操作"
      type="button"
    >
      <MoreVertical size={16} />
    </button>
  );
}

export function FeatureItemMenu({
  anchorRect,
  builtin,
  favorite,
  onClose,
  onDelete,
  onEdit,
  onInvoke,
  onPin,
  onToggleFavorite,
}: FeatureItemMenuProps) {
  const { menuRef, run } = useMenuBehavior(onClose);

  return createPortal(
    <div className="session-item-menu feature-item-menu" ref={menuRef} role="menu" style={menuPosition(anchorRect, builtin)}>
      <button onClick={() => run(onInvoke)} role="menuitem" type="button"><Play size={15} />运行</button>
      <button onClick={() => run(onToggleFavorite)} role="menuitem" type="button">
        {favorite ? <StarOff size={15} /> : <Star size={15} />}
        {favorite ? '取消收藏' : '收藏'}
      </button>
      <button onClick={() => run(onPin)} role="menuitem" type="button"><Pin size={15} />置顶</button>
      {!builtin && onEdit && <button onClick={() => run(onEdit)} role="menuitem" type="button"><Edit3 size={15} />编辑</button>}
      {!builtin && onDelete && <button className="danger" onClick={() => run(onDelete)} role="menuitem" type="button"><Trash2 size={15} />删除</button>}
    </div>,
    document.body,
  );
}

interface DeleteFeatureDialogProps {
  name: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

export function DeleteFeatureDialog({ name, onCancel, onConfirm }: DeleteFeatureDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function confirm() {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await onConfirm();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除失败，请重试');
      setSubmitting(false);
    }
  }

  function cancelBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (!submitting && event.target === event.currentTarget) {
      onCancel();
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={cancelBackdrop}>
      <section aria-labelledby="delete-feature-title" aria-modal="true" className="session-dialog" role="dialog">
        <h2 id="delete-feature-title">删除功能</h2>
        <p>确认删除“{name}”吗？删除后该功能配置将无法恢复。</p>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <footer>
          <button disabled={submitting} onClick={onCancel} type="button">取消删除</button>
          <button className="danger-button" disabled={submitting} onClick={() => void confirm()} type="button">
            {submitting ? '正在删除' : '确认删除'}
          </button>
        </footer>
      </section>
    </div>
  );
}

function menuPosition(anchorRect: Pick<DOMRect, 'bottom' | 'right' | 'top'> | undefined, builtin: boolean) {
  const margin = 8;
  const gap = 4;
  const width = 144;
  const height = builtin ? 108 : 172;
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
