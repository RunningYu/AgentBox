import { useEffect, useState, type FormEvent, type MouseEvent } from 'react';

interface RenameSessionDialogProps {
  name: string;
  onCancel: () => void;
  onSave: (name: string) => void;
}

export function RenameSessionDialog({ name, onCancel, onSave }: RenameSessionDialogProps) {
  const [value, setValue] = useState(name);
  const normalized = value.trim();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (normalized) onSave(normalized);
  }

  function cancelBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onCancel();
  }

  return (
    <div className="modal-backdrop" onMouseDown={cancelBackdrop}>
      <form className="session-dialog" onSubmit={submit}>
        <h2>重命名会话</h2>
        <label>新会话名称<input aria-label="新会话名称" autoFocus onChange={(event) => setValue(event.target.value)} value={value} /></label>
        <footer>
          <button onClick={onCancel} type="button">取消</button>
          <button className="primary-button" disabled={!normalized} type="submit">保存名称</button>
        </footer>
      </form>
    </div>
  );
}
