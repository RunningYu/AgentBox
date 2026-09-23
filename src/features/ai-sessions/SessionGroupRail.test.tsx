import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AiSessionGroup, AiSessionRecord } from '../../shared/types';
import { DeleteSessionGroupDialog } from './DeleteSessionGroupDialog';
import { MoveSessionDialog } from './MoveSessionDialog';
import { SessionGroupDialog } from './SessionGroupDialog';
import { SessionGroupRail, type SessionGroupRailProps } from './SessionGroupRail';

const groups: AiSessionGroup[] = [
  { id: 'later', name: '后创建', createdAt: 20, collapsed: false },
  { id: 'earlier', name: '先创建', createdAt: 10, collapsed: false },
];

function session(overrides: Partial<AiSessionRecord> = {}): AiSessionRecord {
  return {
    id: 'session-1',
    name: '会话一',
    agent: 'claude',
    cwd: '/tmp',
    status: 'stopped',
    groupId: 'earlier',
    history: '',
    createdAt: 1,
    updatedAt: new Date(2026, 0, 1, 9, 30).getTime(),
    pinned: false,
    ...overrides,
  };
}

function railProps(overrides: Partial<SessionGroupRailProps> = {}): SessionGroupRailProps {
  return {
    groups,
    sessions: [
      session({ id: 'running', name: '运行会话', status: 'running' }),
      session({ id: 'ungrouped', name: '散落会话', groupId: null }),
    ],
    activeId: null,
    loading: false,
    onCreateGroup: vi.fn(),
    onCreateSession: vi.fn(),
    onToggleGroup: vi.fn(),
    onRenameGroup: vi.fn(),
    onDeleteGroup: vi.fn(),
    onPermanentlyDeleteGroup: vi.fn(),
    onRestoreGroup: vi.fn(),
    onToggleGroupPin: vi.fn(),
    onMoveSession: vi.fn(),
    onSelectSession: vi.fn(),
    onRenameSession: vi.fn(),
    onTogglePin: vi.fn(),
    onDeleteSession: vi.fn(),
    ...overrides,
  };
}

function GroupDialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">打开分组对话框</button>
      {open && <SessionGroupDialog groups={groups} mode="create" onCancel={() => setOpen(false)} onSave={vi.fn()} />}
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('SessionGroupRail', () => {
  it('orders user groups by display order and always renders ungrouped last', () => {
    const { container } = render(<SessionGroupRail {...railProps({ sessions: [] })} />);

    expect(container.firstElementChild).toHaveClass('session-group-rail');
    expect(container.querySelector('.session-group-list')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)).toEqual([
      '先创建',
      '后创建',
      '未分组',
    ]);
  });

  it('keeps the virtual ungrouped section visible while loading', () => {
    render(<SessionGroupRail {...railProps({ loading: true, sessions: [] })} />);

    expect(screen.getByRole('heading', { level: 3, name: '未分组' })).toBeInTheDocument();
  });

  it('filters deleted groups from the toolbar and dispatches trash actions', async () => {
    const user = userEvent.setup();
    const deletedGroup = { ...groups[0], deletedAt: 100 };
    const onRestoreGroup = vi.fn();
    const onPermanentlyDeleteGroup = vi.fn();
    const onSelectSession = vi.fn();
    render(<SessionGroupRail {...railProps({
      groups: [groups[1], deletedGroup],
      onPermanentlyDeleteGroup,
      onRestoreGroup,
      onSelectSession,
      sessions: [session({ id: 'deleted-session', name: '已删除会话', groupId: deletedGroup.id })],
    })} />);

    const filterTrigger = screen.getByRole('button', { name: '筛选会话分组' });
    expect(filterTrigger).toHaveTextContent('在使用');
    expect(screen.queryByRole('listbox', { name: '筛选会话分组' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: '先创建' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3, name: '后创建' })).not.toBeInTheDocument();

    await user.click(filterTrigger);
    const filterMenu = screen.getByRole('listbox', { name: '筛选会话分组' });
    expect(within(filterMenu).getByRole('option', { name: '已删除' })).toBeInTheDocument();
    await user.click(within(filterMenu).getByRole('option', { name: '已删除' }));
    expect(screen.getByRole('heading', { level: 3, name: '后创建' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3, name: '先创建' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '恢复后创建' }));
    expect(onRestoreGroup).toHaveBeenCalledWith(expect.objectContaining({ id: 'later' }));
    await user.click(screen.getByRole('button', { name: '永久删除后创建' }));
    expect(onPermanentlyDeleteGroup).toHaveBeenCalledWith(expect.objectContaining({ id: 'later' }));
    await user.click(screen.getByRole('button', { name: '已删除会话 已停止' }));
    expect(onSelectSession).toHaveBeenCalledWith('deleted-session');
    await user.click(screen.getByRole('button', { name: '已删除会话 会话操作' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('hides collapsed sessions while keeping running counts visible', () => {
    render(<SessionGroupRail {...railProps({ groups: [{ ...groups[1], collapsed: true }] })} />);

    expect(screen.queryByRole('button', { name: /运行会话 运行中/ })).not.toBeInTheDocument();
    expect(screen.getByText('1 个会话 · 1 个运行中')).toBeInTheDocument();
  });

  it('creates sessions with the selected group id or null', async () => {
    const user = userEvent.setup();
    const onCreateSession = vi.fn();
    render(<SessionGroupRail {...railProps({ onCreateSession })} />);

    await user.click(screen.getByRole('button', { name: '在先创建中新建会话' }));
    await user.click(screen.getByRole('button', { name: '在未分组中新建会话' }));

    expect(onCreateSession).toHaveBeenNthCalledWith(1, 'earlier');
    expect(onCreateSession).toHaveBeenNthCalledWith(2, null);
  });

  it('offers pin, rename and delete for user groups but no menu for ungrouped', async () => {
    const user = userEvent.setup();
    const onRenameGroup = vi.fn();
    const onDeleteGroup = vi.fn();
    const onToggleGroupPin = vi.fn();
    render(<SessionGroupRail {...railProps({ onDeleteGroup, onRenameGroup, onToggleGroupPin })} />);

    expect(screen.queryByRole('button', { name: '未分组操作' })).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: '先创建分组操作' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu');
    expect(menu.parentElement).toBe(document.body);
    await user.click(within(menu).getByRole('menuitem', { name: '置顶' }));
    expect(onToggleGroupPin).toHaveBeenCalledWith(expect.objectContaining({ id: 'earlier' }));

    await user.click(screen.getByRole('button', { name: '先创建分组操作' }));
    await user.click(screen.getByRole('menuitem', { name: '重命名' }));
    expect(onRenameGroup).toHaveBeenCalledWith(expect.objectContaining({ id: 'earlier' }));

    await user.click(screen.getByRole('button', { name: '先创建分组操作' }));
    await user.click(screen.getByRole('menuitem', { name: '删除分组' }));
    expect(onDeleteGroup).toHaveBeenCalledWith(expect.objectContaining({ id: 'earlier' }));
  });

  it('dispatches move from a session menu and toggles the same menu closed', async () => {
    const user = userEvent.setup();
    const onMoveSession = vi.fn();
    render(<SessionGroupRail {...railProps({ onMoveSession })} />);

    const trigger = screen.getByRole('button', { name: '运行会话 会话操作' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('menuitem', { name: '移动到分组' }));
    expect(onMoveSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'running' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('dispatches duplicate from a session menu', async () => {
    const user = userEvent.setup();
    const onDuplicateSession = vi.fn();
    render(<SessionGroupRail {...railProps({ onDuplicateSession })} />);

    await user.click(screen.getByRole('button', { name: '运行会话 会话操作' }));
    await user.click(screen.getByRole('menuitem', { name: '复制会话' }));

    expect(onDuplicateSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'running' }));
  });

  it('closes the group menu on Escape and outside pointer down', async () => {
    const user = userEvent.setup();
    render(<SessionGroupRail {...railProps()} />);
    const trigger = screen.getByRole('button', { name: '先创建分组操作' });

    await user.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('SessionGroupDialog', () => {
  it.each([
    ['create', undefined, '   ', '分组名称不能为空'],
    ['create', undefined, '先创建', '分组名称已存在'],
    ['rename', groups[0], '   ', '分组名称不能为空'],
    ['rename', groups[0], '先创建', '分组名称已存在'],
  ] as const)('shows validation errors in %s mode', async (mode, group, value, message) => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(mode === 'create'
      ? <SessionGroupDialog groups={groups} mode="create" onCancel={vi.fn()} onSave={onSave} />
      : <SessionGroupDialog group={group!} groups={groups} mode="rename" onCancel={vi.fn()} onSave={onSave} />);

    const input = screen.getByLabelText('分组名称');
    await user.clear(input);
    await user.type(input, value);
    await user.click(screen.getByRole('button', { name: mode === 'create' ? '创建分组' : '保存名称' }));

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('allows a renamed group to keep its own name and trims the saved value', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<SessionGroupDialog group={groups[0]} groups={groups} mode="rename" onCancel={vi.fn()} onSave={onSave} />);

    const input = screen.getByLabelText('分组名称');
    await user.clear(input);
    await user.type(input, '  后创建  ');
    await user.click(screen.getByRole('button', { name: '保存名称' }));
    expect(onSave).toHaveBeenCalledWith('后创建');
  });

  it('traps focus, closes on Escape and restores focus to the opener', async () => {
    const user = userEvent.setup();
    render(<GroupDialogHarness />);
    const trigger = screen.getByRole('button', { name: '打开分组对话框' });
    await user.click(trigger);

    const dialog = screen.getByRole('dialog');
    const input = screen.getByLabelText('分组名称');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(input).toHaveFocus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(screen.getByRole('button', { name: '创建分组' })).toHaveFocus();
    await user.tab();
    expect(input).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe('MoveSessionDialog', () => {
  it('lists ungrouped and all groups and does not submit the current group', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<MoveSessionDialog currentGroupId="earlier" groups={groups} onCancel={vi.fn()} onSave={onSave} sessionName="会话一" />);

    expect(screen.getByText(/会话一/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('目标分组')).toHaveFocus();
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['未分组', '先创建', '后创建']);
    expect(screen.getByRole('button', { name: '移动会话' })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('目标分组'), '');
    await user.click(screen.getByRole('button', { name: '移动会话' }));
    expect(onSave).toHaveBeenCalledWith(null);
  });
});

describe('DeleteSessionGroupDialog', () => {
  it.each([
    [2, '停止并移入已删除'],
    [0, '移入已删除'],
  ] as const)('shows counts and the correct action for %i running sessions', (runningCount, action) => {
    render(<DeleteSessionGroupDialog groupName="先创建" onCancel={vi.fn()} onConfirm={vi.fn()} runningCount={runningCount} sessionCount={5} />);

    expect(screen.getByText(/先创建/)).toBeInTheDocument();
    expect(screen.getByText(/5 个会话/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`${runningCount} 个正在运行`))).toBeInTheDocument();
    expect(screen.getByText(/移入已删除列表.*仍可恢复/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    expect(screen.getByRole('button', { name: action })).toBeInTheDocument();
  });

  it('prevents duplicate async deletion and recovers after rejection', async () => {
    const pending = deferred<void>();
    const onConfirm = vi.fn(() => pending.promise);
    render(<DeleteSessionGroupDialog groupName="先创建" onCancel={vi.fn()} onConfirm={onConfirm} runningCount={2} sessionCount={5} />);

    const confirm = screen.getByRole('button', { name: '停止并移入已删除' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '正在停止并移入' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();

    pending.reject(new Error('删除失败'));
    expect(await screen.findByRole('alert')).toHaveTextContent('删除失败');
    expect(screen.getByRole('button', { name: '停止并移入已删除' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeEnabled();
  });

  it('requires an explicit irreversible confirmation for permanent deletion', () => {
    render(<DeleteSessionGroupDialog groupName="先创建" onCancel={vi.fn()} onConfirm={vi.fn()} permanent runningCount={0} sessionCount={5} />);

    expect(screen.getByRole('dialog', { name: '永久删除分组' })).toBeInTheDocument();
    expect(screen.getByText(/永久删除.*历史记录.*无法恢复/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '永久删除' })).toBeInTheDocument();
  });
});
