import { useState, type FormEvent, type MouseEvent } from 'react';
import type { AiSessionGroup } from '../../shared/types';
import { useModalFocus } from './modalFocus';
import { groupsForDisplay } from './workspaceModel';

interface MoveSessionDialogProps {
  currentGroupId: string | null;
  groups: AiSessionGroup[];
  onCancel: () => void;
  onSave: (groupId: string | null) => void;
  sessionName: string;
}

export function MoveSessionDialog({ currentGroupId, groups, onCancel, onSave, sessionName }: MoveSessionDialogProps) {
  const [targetGroupId, setTargetGroupId] = useState(currentGroupId ?? '');
  const currentValue = currentGroupId ?? '';
  const orderedGroups = groupsForDisplay(groups);
  const { dialogRef, initialFocusRef } = useModalFocus<HTMLFormElement, HTMLSelectElement>(onCancel);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (targetGroupId !== currentValue) onSave(targetGroupId || null);
  }

  function cancelBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onCancel();
  }

  return (
    <div className="modal-backdrop" onMouseDown={cancelBackdrop}>
      <form aria-labelledby="move-session-title" aria-modal="true" className="session-dialog" onSubmit={submit} ref={dialogRef} role="dialog">
        <h2 id="move-session-title">移动会话</h2>
        <p>将“{sessionName}”移动到：</p>
        <label>
          目标分组
          <select aria-label="目标分组" onChange={(event) => setTargetGroupId(event.target.value)} ref={initialFocusRef} value={targetGroupId}>
            <option value="">未分组</option>
            {orderedGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
        </label>
        <footer>
          <button onClick={onCancel} type="button">取消</button>
          <button className="primary-button" disabled={targetGroupId === currentValue} type="submit">移动会话</button>
        </footer>
      </form>
    </div>
  );
}
