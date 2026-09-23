import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DeleteSessionDialog } from './DeleteSessionDialog';
import { RenameSessionDialog } from './RenameSessionDialog';
import { SessionGroupMenu } from './SessionGroupMenu';
import { SessionItemMenu } from './SessionItemMenu';

function MenuHarness({ kind, opensDialog = false }: { kind: 'group' | 'session'; opensDialog?: boolean }) {
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const triggerLabel = kind === 'group' ? '打开分组菜单' : '打开会话菜单';
  const rename = () => {
    if (opensDialog) setDialogOpen(true);
  };
  return (
    <>
      <button aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((value) => !value)} type="button">{triggerLabel}</button>
      {open && (kind === 'group' ? (
        <SessionGroupMenu onClose={() => setOpen(false)} onDelete={vi.fn()} onRename={rename} onTogglePin={vi.fn()} pinned={false} />
      ) : (
        <SessionItemMenu onClose={() => setOpen(false)} onDelete={vi.fn()} onMove={vi.fn()} onRename={rename} onTogglePin={vi.fn()} pinned={false} />
      ))}
      {dialogOpen && <input aria-label="后续对话框输入" autoFocus />}
    </>
  );
}

describe('SessionItemMenu', () => {
  it('renders outside the scrolling session list', () => {
    render(
      <div className="session-list">
        <SessionItemMenu
          onClose={vi.fn()}
          onDelete={vi.fn()}
          onMove={vi.fn()}
          onRename={vi.fn()}
          onTogglePin={vi.fn()}
          pinned={false}
        />
      </div>,
    );

    expect(screen.getByRole('menu').parentElement).toBe(document.body);
  });

  it('dispatches actions and closes on Escape or outside pointer down', async () => {
    const user = userEvent.setup();
    const actions = { onClose: vi.fn(), onDelete: vi.fn(), onMove: vi.fn(), onRename: vi.fn(), onTogglePin: vi.fn() };
    const { rerender } = render(<SessionItemMenu pinned={false} {...actions} />);

    await user.click(screen.getByRole('menuitem', { name: '置顶' }));
    expect(actions.onTogglePin).toHaveBeenCalled();

    rerender(<SessionItemMenu pinned {...actions} />);
    expect(screen.getByRole('menuitem', { name: '取消置顶' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(actions.onClose).toHaveBeenCalled();

    fireEvent.pointerDown(document.body);
    expect(actions.onClose).toHaveBeenCalledTimes(3);

    fireEvent.scroll(window);
    expect(actions.onClose).toHaveBeenCalledTimes(4);
  });

  it('dispatches move and closes the menu', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onMove = vi.fn();
    render(
      <SessionItemMenu
        onClose={onClose}
        onDelete={vi.fn()}
        onMove={onMove}
        onRename={vi.fn()}
        onTogglePin={vi.fn()}
        pinned={false}
      />,
    );

    await user.click(screen.getByRole('menuitem', { name: '移动到分组' }));
    expect(onMove).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not render move when no move callback is provided', () => {
    render(
      <SessionItemMenu
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        onTogglePin={vi.fn()}
        pinned={false}
      />,
    );

    expect(screen.queryByRole('menuitem', { name: '移动到分组' })).not.toBeInTheDocument();
  });
});

describe.each(['session', 'group'] as const)('%s menu accessibility', (kind) => {
  it('uses menuitem roles, focuses the first item and supports circular keyboard navigation', async () => {
    const user = userEvent.setup();
    render(<MenuHarness kind={kind} />);
    await user.click(screen.getByRole('button', { name: kind === 'group' ? '打开分组菜单' : '打开会话菜单' }));

    const items = screen.getAllByRole('menuitem');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{End}');
    expect(items[items.length - 1]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(items[items.length - 1]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(items[0]).toHaveFocus();
  });

  it('restores trigger focus after Escape and outside close', async () => {
    const user = userEvent.setup();
    render(<MenuHarness kind={kind} />);
    const trigger = screen.getByRole('button', { name: kind === 'group' ? '打开分组菜单' : '打开会话菜单' });

    await user.click(trigger);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(trigger);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('does not steal focus from a dialog opened by an action', async () => {
    const user = userEvent.setup();
    render(<MenuHarness kind={kind} opensDialog />);
    await user.click(screen.getByRole('button', { name: kind === 'group' ? '打开分组菜单' : '打开会话菜单' }));
    await user.click(screen.getByRole('menuitem', { name: '重命名' }));

    expect(screen.getByLabelText('后续对话框输入')).toHaveFocus();
  });
});

describe('session dialogs', () => {
  it('trims and saves a nonempty renamed session', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RenameSessionDialog name="旧名称" onCancel={vi.fn()} onSave={onSave} />);

    await user.clear(screen.getByLabelText('新会话名称'));
    await user.type(screen.getByLabelText('新会话名称'), '  新名称  ');
    await user.click(screen.getByRole('button', { name: '保存名称' }));

    expect(onSave).toHaveBeenCalledWith('新名称');
  });

  it('requires confirmation before deleting the named session', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<DeleteSessionDialog name="重要会话" onCancel={onCancel} onConfirm={onConfirm} />);

    expect(screen.getByText(/重要会话/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消删除' }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(onConfirm).toHaveBeenCalled();
  });
});
