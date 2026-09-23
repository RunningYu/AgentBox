import { describe, expect, it } from 'vitest';
import type { AiSessionGroup, AiSessionMetadata, AiSessionRecord } from '../../shared/types';
import {
  featureWindowStateKey,
  groupsByDeletionState,
  groupsForDisplay,
  moveSession,
  normalizeWorkspace,
  sessionsForGroup,
  toPersistedSession,
  validateGroupName,
} from './workspaceModel';

function session(overrides: Partial<AiSessionMetadata> = {}): AiSessionMetadata {
  return {
    id: 'session-1',
    name: 'Session',
    agent: 'claude',
    cwd: '/tmp',
    status: 'stopped',
    groupId: null,
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    ...overrides,
  };
}

describe('workspace model', () => {
  it('migrates valid legacy array records into the ungrouped workspace', () => {
    const workspace = normalizeWorkspace([
      {
        id: 'legacy-1',
        name: ' Legacy ',
        agent: 'codex',
        cwd: '/tmp',
        status: 'running',
        history: 'old output',
        createdAt: 10,
        updatedAt: 20,
        generation: 'old-generation',
        error: 'old error',
      },
      { id: 'invalid', agent: 'other' },
    ]);

    expect(workspace).toEqual({
      version: 2,
      groups: [],
      sessions: [{
        id: 'legacy-1',
        name: ' Legacy ',
        agent: 'codex',
        cwd: '/tmp',
        status: 'stopped',
        groupId: null,
        createdAt: 10,
        updatedAt: 20,
        pinned: false,
      }],
      featureWindowStates: [],
    });
    expect(workspace.sessions[0]).not.toHaveProperty('history');
  });

  it('normalizes invalid v2 group references to ungrouped', () => {
    const workspace = normalizeWorkspace({
      version: 2,
      groups: [{ id: 'group-1', name: 'Group', createdAt: 1, collapsed: false }],
      sessions: [
        { ...session({ groupId: 'missing', status: 'running' }), history: 'discarded', generation: 'old', error: 'old' },
        session({ id: 'valid', groupId: 'group-1' }),
      ],
    });

    expect(workspace.sessions.map(({ id, groupId }) => ({ id, groupId }))).toEqual([
      { id: 'session-1', groupId: null },
      { id: 'valid', groupId: 'group-1' },
    ]);
    expect(workspace.sessions[0].status).toBe('stopped');
    expect(workspace.sessions[0]).not.toHaveProperty('history');
    expect(workspace.sessions[0]).not.toHaveProperty('generation');
    expect(workspace.sessions[0]).not.toHaveProperty('error');
  });

  it('normalizes feature window completion states by feature and valid group', () => {
    const workspace = normalizeWorkspace({
      version: 2,
      groups: [{ id: 'group-1', name: 'Group', createdAt: 1, collapsed: false }],
      sessions: [],
      featureWindowStates: [
        { featureId: 'workflow-1', groupId: 'group-1', done: { 0: true, 1: false, bad: true }, updatedAt: 10 },
        { featureId: 'workflow-2', groupId: null, done: { 2: true }, updatedAt: 11 },
        { featureId: 'workflow-3', groupId: 'missing', done: { 0: true }, updatedAt: 12 },
        { featureId: '', groupId: 'group-1', done: { 0: true }, updatedAt: 13 },
      ],
    });

    expect(workspace.featureWindowStates).toEqual([
      { featureId: 'workflow-1', groupId: 'group-1', done: { 0: true }, updatedAt: 10 },
      { featureId: 'workflow-2', groupId: null, done: { 2: true }, updatedAt: 11 },
    ]);
  });

  it('builds stable feature window state keys from feature and group', () => {
    expect(featureWindowStateKey('workflow-1', 'group-1')).toBe('workflow-1::group-1');
    expect(featureWindowStateKey('workflow-1', null)).toBe('workflow-1::__ungrouped__');
  });

  it('persists runtime sessions through an explicit metadata whitelist', () => {
    const runtime: AiSessionRecord = {
      ...session({ status: 'running' }),
      history: 'terminal output',
      generation: 'generation-1',
      error: 'transient error',
    };

    expect(toPersistedSession(runtime)).toEqual({
      id: 'session-1',
      name: 'Session',
      agent: 'claude',
      cwd: '/tmp',
      status: 'running',
      groupId: null,
      createdAt: 1,
      updatedAt: 1,
      pinned: false,
    });
  });

  it('normalizes missing group pin flags to false and preserves pinned groups', () => {
    const workspace = normalizeWorkspace({
      version: 2,
      groups: [
        { id: 'old', name: 'Old', createdAt: 1, collapsed: false },
        { id: 'pin', name: 'Pin', createdAt: 2, collapsed: false, pinned: true },
      ],
      sessions: [],
    });

    expect(workspace.groups).toEqual([
      { id: 'old', name: 'Old', createdAt: 1, collapsed: false, pinned: false },
      { id: 'pin', name: 'Pin', createdAt: 2, collapsed: false, pinned: true },
    ]);
  });

  it('preserves deleted group timestamps while keeping legacy groups active', () => {
    const workspace = normalizeWorkspace({
      version: 2,
      groups: [
        { id: 'active', name: 'Active', createdAt: 1, collapsed: false },
        { id: 'deleted', name: 'Deleted', createdAt: 2, collapsed: true, deletedAt: 99 },
      ],
      sessions: [],
    });

    expect(workspace.groups).toEqual([
      { id: 'active', name: 'Active', createdAt: 1, collapsed: false, pinned: false },
      { id: 'deleted', name: 'Deleted', createdAt: 2, collapsed: true, pinned: false, deletedAt: 99 },
    ]);
    expect(groupsByDeletionState(workspace.groups, false).map(({ id }) => id)).toEqual(['active']);
    expect(groupsByDeletionState(workspace.groups, true).map(({ id }) => id)).toEqual(['deleted']);
  });

  it('trims group names, discards empty names, and deduplicates normalized names', () => {
    const workspace = normalizeWorkspace({
      version: 2,
      groups: [
        { id: 'first', name: ' Backend ', createdAt: 1, collapsed: false },
        { id: 'empty', name: '   ', createdAt: 2, collapsed: false },
        { id: 'duplicate', name: 'Backend', createdAt: 3, collapsed: true },
      ],
      sessions: [session({ groupId: 'duplicate' })],
    });

    expect(workspace.groups).toEqual([
      { id: 'first', name: 'Backend', createdAt: 1, collapsed: false, pinned: false },
    ]);
    expect(workspace.sessions[0].groupId).toBeNull();
  });

  it('rejects empty and duplicate group names after trimming', () => {
    const groups = [{ id: 'group-1', name: 'Backend', createdAt: 1, collapsed: false }];

    expect(() => validateGroupName(groups, '   ')).toThrow('分组名称不能为空');
    expect(() => validateGroupName(groups, ' Backend ')).toThrow('分组名称已存在');
    expect(validateGroupName(groups, ' Backend ', 'group-1')).toBe('Backend');
  });

  it('sorts pinned groups first, then by creation time, without changing the input', () => {
    const groups: AiSessionGroup[] = [
      { id: 'new', name: 'New', createdAt: 20, collapsed: false },
      { id: 'old', name: 'Old', createdAt: 10, collapsed: true },
      { id: 'pinned-new', name: 'Pinned New', createdAt: 30, collapsed: false, pinned: true },
      { id: 'pinned-old', name: 'Pinned Old', createdAt: 5, collapsed: false, pinned: true },
    ];

    expect(groupsForDisplay(groups).map(({ id }) => id)).toEqual(['pinned-old', 'pinned-new', 'old', 'new']);
    expect(groups.map(({ id }) => id)).toEqual(['new', 'old', 'pinned-new', 'pinned-old']);
  });

  it('keeps input order for groups with the same creation time', () => {
    const groups: AiSessionGroup[] = [
      { id: 'first', name: 'First', createdAt: 10, collapsed: false },
      { id: 'second', name: 'Second', createdAt: 10, collapsed: false },
    ];

    expect(groupsForDisplay(groups).map(({ id }) => id)).toEqual(['first', 'second']);
  });

  it('filters a group and keeps pinned sessions first without reordering by activity', () => {
    const sessions = [
      session({ id: 'normal-new', groupId: 'group-1', updatedAt: 30 }),
      session({ id: 'pinned-old', groupId: 'group-1', updatedAt: 10, pinned: true }),
      session({ id: 'pinned-new', groupId: 'group-1', updatedAt: 20, pinned: true }),
      session({ id: 'other', groupId: null, updatedAt: 40 }),
    ];

    expect(sessionsForGroup(sessions, 'group-1').map(({ id }) => id)).toEqual([
      'pinned-old', 'pinned-new', 'normal-new',
    ]);
    expect(sessions.map(({ id }) => id)).toEqual([
      'normal-new', 'pinned-old', 'pinned-new', 'other',
    ]);
  });

  it('keeps input order for sessions with equal pin and update values', () => {
    const sessions = [
      session({ id: 'first', updatedAt: 10 }),
      session({ id: 'second', updatedAt: 10 }),
    ];

    expect(sessionsForGroup(sessions, null).map(({ id }) => id)).toEqual(['first', 'second']);
  });

  it('keeps the original order for unpinned sessions even when activity changes', () => {
    const sessions = [
      session({ id: 'first', updatedAt: 30 }),
      session({ id: 'second', updatedAt: 10 }),
    ];

    expect(sessionsForGroup(sessions, null).map(({ id }) => id)).toEqual(['first', 'second']);
  });

  it('moves only the target session without mutating the input', () => {
    const sessions = [session(), session({ id: 'session-2' })];
    const moved = moveSession(sessions, 'session-1', 'group-1', 99);

    expect(moved[0]).toEqual({ ...sessions[0], groupId: 'group-1', updatedAt: 99 });
    expect(moved[1]).toBe(sessions[1]);
    expect(sessions[0].groupId).toBeNull();
  });

  it('returns the original array when a move has no effect', () => {
    const sessions = [session({ groupId: 'group-1', updatedAt: 10 })];

    expect(moveSession(sessions, 'missing', 'group-2', 99)).toBe(sessions);
    expect(moveSession(sessions, 'session-1', 'group-1', 99)).toBe(sessions);
    expect(sessions[0].updatedAt).toBe(10);
  });
});
