import { describe, expect, it } from 'vitest';
import {
  appendSessionHistory,
  createAiSession,
  parseResumeSessionInput,
  restoreAiSessions,
  sortAiSessions,
} from './sessionModel';

describe('AI session model', () => {
  it('caps terminal history at a complete synchronized-output frame', () => {
    const syncFrame = '\u001b[?2026hnew frame\u001b[?2026l';
    const history = appendSessionHistory('x'.repeat(40), syncFrame, 64);

    expect(history).toBe(`\u001bc\u001b[2J\u001b[H${syncFrame}`);
    expect(history).not.toMatch(/^026[hl]/);
  });

  it('creates a running session with the caller-provided identity', () => {
    const session = createAiSession({
      id: 'session-1',
      name: '租赁需求分析',
      agent: 'claude',
      cwd: '/tmp/agentbox-project',
      now: 100,
    });

    expect(session).toEqual({
      id: 'session-1',
      name: '租赁需求分析',
      agent: 'claude',
      cwd: '/tmp/agentbox-project',
      status: 'running',
      groupId: null,
      history: '',
      createdAt: 100,
      updatedAt: 100,
      pinned: false,
    });
  });

  it('restores persisted sessions as stopped and removes transient process state', () => {
    const [session] = restoreAiSessions([
      {
        id: 'session-1',
        name: 'Codex 修复',
        agent: 'codex',
        cwd: '/tmp',
        status: 'running',
        history: 'previous output',
        createdAt: 100,
        updatedAt: 200,
        generation: 99,
        error: 'old error',
      },
    ]);

    expect(session.status).toBe('stopped');
    expect(session.generation).toBeUndefined();
    expect(session.error).toBeUndefined();
    expect(session.groupId).toBeNull();
    expect(session.history).toBe('previous output');
  });

  it('discards malformed persisted records', () => {
    expect(restoreAiSessions([{ id: 'bad', agent: 'other' }, null, 3])).toEqual([]);
  });

  it('discards persisted records with non-finite timestamps', () => {
    const base = {
      id: 'session-1',
      name: 'Invalid time',
      agent: 'claude',
      cwd: '/tmp',
      status: 'stopped',
      history: '',
      createdAt: 100,
      updatedAt: 200,
    };

    expect(restoreAiSessions([
      { ...base, createdAt: Number.NaN },
      { ...base, id: 'infinite', updatedAt: Number.POSITIVE_INFINITY },
    ])).toEqual([]);
  });

  it('preserves only valid CLI session UUIDs when restoring records', () => {
    const base = {
      id: 'session-1',
      name: '恢复会话',
      agent: 'claude',
      cwd: '/tmp',
      status: 'stopped',
      history: '',
      createdAt: 100,
      updatedAt: 200,
    };
    const validId = '019f8565-e310-7f73-b003-8d5bf94a7982';

    expect(restoreAiSessions([{ ...base, cliSessionId: validId }])[0].cliSessionId).toBe(validId);
    expect(restoreAiSessions([{ ...base, cliSessionId: 'not-a-uuid' }])[0].cliSessionId).toBeUndefined();
  });

  it('parses Codex and Claude resume commands into agent and CLI session id', () => {
    expect(parseResumeSessionInput('codex resume 019f8dbe-9ae7-7150-948e-36cbf107ebdd')).toEqual({
      agent: 'codex',
      cliSessionId: '019f8dbe-9ae7-7150-948e-36cbf107ebdd',
    });
    expect(parseResumeSessionInput('claude --resume 256f50a7-62ed-45bc-abf6-f90ece54c58c')).toEqual({
      agent: 'claude',
      cliSessionId: '256f50a7-62ed-45bc-abf6-f90ece54c58c',
    });
    expect(parseResumeSessionInput('256f50a7-62ed-45bc-abf6-f90ece54c58c')).toEqual({
      cliSessionId: '256f50a7-62ed-45bc-abf6-f90ece54c58c',
    });
    expect(parseResumeSessionInput('codex resume bad-id')).toBeUndefined();
  });

  it('defaults old records to unpinned and keeps pinned sessions first in input order', () => {
    const records = restoreAiSessions([
      {
        id: 'normal-new', name: '普通新', agent: 'claude', cwd: '/tmp', status: 'stopped',
        history: '', createdAt: 1, updatedAt: 30,
      },
      {
        id: 'pinned-old', name: '置顶旧', agent: 'codex', cwd: '/tmp', status: 'stopped',
        history: '', createdAt: 1, updatedAt: 10, pinned: true,
      },
      {
        id: 'pinned-new', name: '置顶新', agent: 'claude', cwd: '/tmp', status: 'stopped',
        history: '', createdAt: 1, updatedAt: 20, pinned: true,
      },
    ]);

    expect(records.find((record) => record.id === 'normal-new')?.pinned).toBe(false);
    expect(sortAiSessions(records).map((record) => record.id)).toEqual([
      'pinned-old', 'pinned-new', 'normal-new',
    ]);
    expect(records.map((record) => record.id)).toEqual(['normal-new', 'pinned-old', 'pinned-new']);
  });

});
