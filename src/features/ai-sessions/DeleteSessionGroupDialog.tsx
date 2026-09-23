import { useRef, useState, type MouseEvent } from 'react';
import { useModalFocus } from './modalFocus';

interface DeleteSessionGroupDialogProps {
  groupName: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  runningCount: number;
  sessionCount: number;
  permanent?: boolean;
}

export function DeleteSessionGroupDialog({
  groupName,
  onCancel,
  onConfirm,
  runningCount,
  sessionCount,
  permanent = false,
}: DeleteSessionGroupDialogProps) {
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const { dialogRef, initialFocusRef } = useModalFocus<HTMLElement, HTMLButtonElement>(onCancel, submitting);

  async function confirm() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      await onConfirm();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除失败，请重试');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function cancelBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (!submitting && event.target === event.currentTarget) onCancel();
  }

  return (
    <div className="modal-backdrop" onMouseDown={cancelBackdrop}>
      <section aria-labelledby="delete-session-group-title" aria-modal="true" className="session-dialog" ref={dialogRef} role="dialog">
        <h2 id="delete-session-group-title">{permanent ? '永久删除分组' : '删除分组'}</h2>
        <p>确认{permanent ? '永久删除' : '删除'}“{groupName}”吗？该分组包含 {sessionCount} 个会话，其中 {runningCount} 个正在运行。</p>
        <p className="dialog-warning">{permanent ? '此操作将永久删除该分组、其中的会话及全部历史记录，无法恢复。' : '分组和其中的会话将移入已删除列表，之后仍可恢复。'}</p>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <footer>
          <button disabled={submitting} onClick={onCancel} ref={initialFocusRef} type="button">取消</button>
          <button className="danger-button" disabled={submitting} onClick={() => void confirm()} type="button">
            {submitting
              ? (permanent ? '正在永久删除' : (runningCount > 0 ? '正在停止并移入' : '正在移入'))
              : (permanent ? '永久删除' : (runningCount > 0 ? '停止并移入已删除' : '移入已删除'))}
          </button>
        </footer>
      </section>
    </div>
  );
}
