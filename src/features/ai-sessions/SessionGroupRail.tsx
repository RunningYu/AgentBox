import { Bot, ChevronDown, ChevronRight, MoreVertical, PanelLeftClose, Pin, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AiSessionGroup, AiSessionRecord } from '../../shared/types';
import { groupsByDeletionState, sessionsForGroup } from './workspaceModel';
import { SessionGroupMenu } from './SessionGroupMenu';
import { SessionItemMenu } from './SessionItemMenu';

export interface SessionGroupRailProps {
  activeId: string | null;
  groups: AiSessionGroup[];
  loading: boolean;
  onCreateGroup: () => void;
  onCreateSession: (groupId: string | null) => void;
  onCreateAgentSession?: (groupId: string | null) => void;
  onCollapseRail?: () => void;
  onDeleteGroup: (group: AiSessionGroup) => void;
  onPermanentlyDeleteGroup: (group: AiSessionGroup) => void;
  onDeleteSession: (session: AiSessionRecord) => void;
  onDuplicateSession?: (session: AiSessionRecord) => void;
  onMoveSession: (session: AiSessionRecord) => void;
  onRenameGroup: (group: AiSessionGroup) => void;
  onRenameSession: (session: AiSessionRecord) => void;
  onRestoreGroup: (group: AiSessionGroup) => void;
  onSelectSession: (sessionId: string) => void;
  onToggleGroup: (groupId: string | null) => void;
  onToggleGroupPin: (group: AiSessionGroup) => void;
  onTogglePin: (session: AiSessionRecord) => void;
  sessions: AiSessionRecord[];
  ungroupedCollapsed?: boolean;
}

interface OpenMenu {
  anchorRect: Pick<DOMRect, 'bottom' | 'right' | 'top'>;
  id: string;
}

export function SessionGroupRail(props: SessionGroupRailProps) {
  const [view, setView] = useState<'active' | 'deleted'>('active');
  const [filterOpen, setFilterOpen] = useState(false);
  const [groupMenu, setGroupMenu] = useState<OpenMenu | null>(null);
  const [sessionMenu, setSessionMenu] = useState<OpenMenu | null>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const orderedGroups = groupsByDeletionState(props.groups, view === 'deleted');

  useEffect(() => {
    if (!filterOpen) return;
    function closeOnOutsidePointerDown(event: PointerEvent) {
      if (!filterRef.current?.contains(event.target as Node)) setFilterOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setFilterOpen(false);
    }
    document.addEventListener('pointerdown', closeOnOutsidePointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [filterOpen]);

  return (
    <div className="session-group-rail">
      <div className="session-group-toolbar">
        <strong>会话分组</strong>
        <span>
          <div className="session-group-filter-wrap" ref={filterRef}>
            <button
              aria-expanded={filterOpen}
              aria-haspopup="listbox"
              aria-label="筛选会话分组"
              className="session-group-filter"
              onClick={() => setFilterOpen((current) => !current)}
              type="button"
            >
              {view === 'active' ? '在使用' : '已删除'}
            </button>
            {filterOpen && (
              <div aria-label="筛选会话分组" className="session-group-filter-menu" role="listbox">
                {([
                  ['active', '在使用'],
                  ['deleted', '已删除'],
                ] as const).map(([value, label]) => (
                  <button
                    aria-selected={view === value}
                    className={view === value ? 'session-group-filter-option active' : 'session-group-filter-option'}
                    key={value}
                    onClick={() => {
                      setView(value);
                      setFilterOpen(false);
                    }}
                    role="option"
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button aria-label="收起会话列表" className="icon-button" onClick={props.onCollapseRail} title="收起会话列表" type="button"><PanelLeftClose size={16} /></button>
          {view === 'active' && <button aria-label="新建分组" className="icon-button" onClick={props.onCreateGroup} title="新建分组" type="button"><Plus size={16} /></button>}
        </span>
      </div>
      <div className="session-group-list">
        {props.loading && <div className="session-group-loading">正在加载...</div>}
        {orderedGroups.map((group) => (
          <SessionGroup
            {...props}
            group={group}
            groupMenu={groupMenu}
            deleted={view === 'deleted'}
            key={group.id}
            onSetGroupMenu={setGroupMenu}
            onSetSessionMenu={setSessionMenu}
            sessionMenu={sessionMenu}
          />
        ))}
        {view === 'active' && <SessionGroup
          {...props}
          collapsed={props.ungroupedCollapsed ?? false}
          group={null}
          groupMenu={groupMenu}
          onSetGroupMenu={setGroupMenu}
          onSetSessionMenu={setSessionMenu}
          sessionMenu={sessionMenu}
        />}
        {view === 'deleted' && orderedGroups.length === 0 && <div className="session-trash-empty">已删除列表为空</div>}
      </div>
    </div>
  );
}

interface SessionGroupProps extends SessionGroupRailProps {
  collapsed?: boolean;
  deleted?: boolean;
  group: AiSessionGroup | null;
  groupMenu: OpenMenu | null;
  onSetGroupMenu: (menu: OpenMenu | null) => void;
  onSetSessionMenu: (menu: OpenMenu | null) => void;
  sessionMenu: OpenMenu | null;
}

function SessionGroup({
  activeId,
  collapsed,
  group,
  deleted = false,
  groupMenu,
  onCreateSession,
  onCreateAgentSession,
  onDeleteGroup,
  onDeleteSession,
  onDuplicateSession,
  onMoveSession,
  onPermanentlyDeleteGroup,
  onRenameGroup,
  onRenameSession,
  onRestoreGroup,
  onSelectSession,
  onSetGroupMenu,
  onSetSessionMenu,
  onToggleGroup,
  onToggleGroupPin,
  onTogglePin,
  sessionMenu,
  sessions,
}: SessionGroupProps) {
  const groupId = group?.id ?? null;
  const name = group?.name ?? '未分组';
  const isCollapsed = group?.collapsed ?? collapsed ?? false;
  const groupedSessions = sessionsForGroup(sessions, groupId) as AiSessionRecord[];
  const runningCount = groupedSessions.filter(({ status }) => status === 'running' || status === 'starting').length;

  return (
    <section className="session-group">
      <header className="session-group-header">
        <button
          aria-expanded={!isCollapsed}
          aria-label={`${isCollapsed ? '展开' : '折叠'}${name}`}
          className="session-group-toggle"
          onClick={() => onToggleGroup(groupId)}
          type="button"
        >
          <span aria-hidden="true" className="session-group-chevron">
            {isCollapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
          </span>
          <span className="session-group-copy">
            <span aria-level={3} className="session-group-name" role="heading">{!deleted && group?.pinned && <Pin aria-label="分组已置顶" size={12} />}{name}</span>
            <small>{groupedSessions.length} 个会话 · {deleted && group?.deletedAt ? `删除于 ${formatDeletedAt(group.deletedAt)}` : `${runningCount} 个运行中`}</small>
          </span>
        </button>
        {!deleted && <button aria-label={`在${name}中新建会话`} className="icon-button session-group-action" onClick={() => onCreateSession(groupId)} title="新建会话" type="button"><Plus size={15} /></button>}
        {!deleted && onCreateAgentSession && <button aria-label={`在${name}中新建 Agent 会话`} className="icon-button session-group-action" onClick={() => onCreateAgentSession(groupId)} title="从 Agent 创建会话" type="button"><Bot size={15} /></button>}
        {deleted && group && <button aria-label={`恢复${name}`} className="icon-button session-group-action" onClick={() => onRestoreGroup(group)} title="恢复分组" type="button"><RotateCcw size={15} /></button>}
        {deleted && group && <button aria-label={`永久删除${name}`} className="icon-button session-group-action danger" onClick={() => onPermanentlyDeleteGroup(group)} title="永久删除" type="button"><Trash2 size={15} /></button>}
        {!deleted && group && (
          <button
            aria-expanded={groupMenu?.id === group.id}
            aria-haspopup="menu"
            aria-label={`${name}分组操作`}
            className="icon-button session-group-action"
            onClick={(event) => {
              const anchorRect = event.currentTarget.getBoundingClientRect();
              onSetGroupMenu(groupMenu?.id === group.id ? null : { anchorRect, id: group.id });
              onSetSessionMenu(null);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            title="分组操作"
            type="button"
          ><MoreVertical size={15} /></button>
        )}
        {group && groupMenu?.id === group.id && (
          <SessionGroupMenu
            anchorRect={groupMenu.anchorRect}
            onClose={() => onSetGroupMenu(null)}
            onDelete={() => onDeleteGroup(group)}
            onRename={() => onRenameGroup(group)}
            onTogglePin={() => onToggleGroupPin(group)}
            pinned={group.pinned}
          />
        )}
      </header>
      {!isCollapsed && groupedSessions.map((item) => (
        <div className={`session-item ${item.id === activeId ? 'active' : ''} ${item.agent === 'gui' ? 'gui-session-item' : ''}`} key={item.id}>
          <button aria-label={`${item.name} ${statusLabel(item.status)}`} className="session-item-main" onClick={() => onSelectSession(item.id)} type="button">
            <span className={`session-agent ${item.agent} ${item.agentConfig ? 'agent-configured' : ''}`}>{agentBadge(item)}</span>
            <span className="session-copy">
              <strong>{item.pinned && <Pin aria-label="已置顶" size={12} />}{item.name}</strong>
              <small>{statusLabel(item.status)} · {formatUpdatedAt(item.updatedAt)}</small>
            </span>
          </button>
          <button
            aria-expanded={sessionMenu?.id === item.id}
            aria-haspopup="menu"
            aria-label={`${item.name} 会话操作`}
            className="session-menu-trigger icon-button"
            onClick={(event) => {
              const anchorRect = event.currentTarget.getBoundingClientRect();
              onSetSessionMenu(sessionMenu?.id === item.id ? null : { anchorRect, id: item.id });
              onSetGroupMenu(null);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            type="button"
          ><MoreVertical size={16} /></button>
          {sessionMenu?.id === item.id && (
            <SessionItemMenu
              anchorRect={sessionMenu.anchorRect}
              onClose={() => onSetSessionMenu(null)}
              onDelete={() => onDeleteSession(item)}
              onDuplicate={onDuplicateSession ? () => onDuplicateSession(item) : undefined}
              onMove={() => onMoveSession(item)}
              onRename={() => onRenameSession(item)}
              onTogglePin={() => onTogglePin(item)}
              pinned={item.pinned}
            />
          )}
        </div>
      ))}
    </section>
  );
}

function statusLabel(status: AiSessionRecord['status']) {
  if (status === 'starting') return '启动中';
  if (status === 'running') return '运行中';
  if (status === 'stopping') return '停止中';
  if (status === 'error') return '异常';
  return '已停止';
}

function agentBadge(session: AiSessionRecord) {
  if (session.agentConfig) return 'AG';
  const agent = session.agent;
  if (agent === 'claude') return 'CC';
  if (agent === 'codex') return 'CX';
  if (agent === 'gui') return 'GUI';
  return 'SH';
}

function formatUpdatedAt(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

function formatDeletedAt(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}
