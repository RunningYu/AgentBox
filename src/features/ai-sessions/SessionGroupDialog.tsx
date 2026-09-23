import { useState, type FormEvent, type MouseEvent } from 'react';
import type { AiSessionGroup } from '../../shared/types';
import { useModalFocus } from './modalFocus';
import { validateGroupName } from './workspaceModel';

interface CommonSessionGroupDialogProps {
  groups: AiSessionGroup[];
  onCancel: () => void;
  onSave: (name: string) => void;
}

type SessionGroupDialogProps = CommonSessionGroupDialogProps & (
  | { mode: 'create' }
  | { group: AiSessionGroup; mode: 'rename' }
);

export function SessionGroupDialog(props: SessionGroupDialogProps) {
  const { groups, mode, onCancel, onSave } = props;
  const group = mode === 'rename' ? props.group : undefined;
  const [value, setValue] = useState(group?.name ?? '');
  const [error, setError] = useState('');
  const { dialogRef, initialFocusRef } = useModalFocus<HTMLFormElement, HTMLInputElement>(onCancel);

  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const name = validateGroupName(groups, value, mode === 'rename' ? group?.id : undefined);
      setError('');
      onSave(name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '分组名称无效');
    }
  }

  function cancelBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onCancel();
  }

  const title = mode === 'create' ? '新建分组' : '重命名分组';
  return (
    <div className="modal-backdrop" onMouseDown={cancelBackdrop}>
      <form aria-labelledby="session-group-dialog-title" aria-modal="true" className="session-dialog" onSubmit={submit} ref={dialogRef} role="dialog">
        <h2 id="session-group-dialog-title">{title}</h2>
        <label>
          分组名称
          <input
            aria-describedby={error ? 'session-group-name-error' : undefined}
            aria-invalid={Boolean(error)}
            aria-label="分组名称"
            ref={initialFocusRef}
            onChange={(event) => {
              setValue(event.target.value);
              if (error) setError('');
            }}
            value={value}
          />
        </label>
        {error && <p className="dialog-error" id="session-group-name-error" role="alert">{error}</p>}
        <footer>
          <button onClick={onCancel} type="button">取消</button>
          <button className="primary-button" type="submit">{mode === 'create' ? '创建分组' : '保存名称'}</button>
        </footer>
      </form>
    </div>
  );
}
