import { useRef, useState, type MouseEvent } from 'react';
import { useModalFocus } from './modalFocus';

interface DeleteSessionDialogProps {
  name: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

export function DeleteSessionDialog({ name, onCancel, onConfirm }: DeleteSessionDialogProps) {
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
      <section aria-labelledby="delete-session-title" aria-modal="true" className="session-dialog" ref={dialogRef} role="dialog">
        <h2 id="delete-session-title">删除会话</h2>
        <p>确认删除“{name}”吗？删除后本地工作记录将无法恢复。</p>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <footer>
          <button disabled={submitting} onClick={onCancel} ref={initialFocusRef} type="button">取消删除</button>
          <button className="danger-button" disabled={submitting} onClick={() => void confirm()} type="button">
            {submitting ? '正在删除' : '确认删除'}
          </button>
        </footer>
      </section>
    </div>
  );
}
