import type {
  AgentSessionConfig,
  AgentType,
  FeatureWindowStepState,
  AiSessionGroup,
  AiSessionMetadata,
  AiSessionRecord,
  AiWorkspaceArchive,
} from '../../shared/types';
import { normalizeGuiAgent, normalizeGuiModel, normalizeSessionUuid } from './sessionModel';

export function normalizeWorkspace(value: unknown): AiWorkspaceArchive {
  const legacy = Array.isArray(value);
  const archive = isObject(value) && value.version === 2 ? value : undefined;
  const groups = legacy ? [] : normalizeGroups(archive?.groups);
  const groupIds = new Set(groups.map(({ id }) => id));
  const storedSessions = legacy ? value : archive?.sessions;
  const sessions = Array.isArray(storedSessions)
    ? storedSessions.flatMap((item) => {
        const session = normalizeSession(item, legacy, groupIds);
        return session ? [session] : [];
      })
    : [];
  const featureWindowStates = legacy ? [] : normalizeFeatureWindowStates(archive?.featureWindowStates, groupIds);

  return { version: 2, groups, sessions, featureWindowStates };
}

export function validateGroupName(
  groups: AiSessionGroup[],
  name: string,
  excludeId?: string,
): string {
  const normalized = name.trim();
  if (!normalized) {
    throw new Error('分组名称不能为空');
  }
  if (groups.some((group) => group.id !== excludeId && group.name === normalized)) {
    throw new Error('分组名称已存在');
  }
  return normalized;
}

export function toPersistedSession(session: AiSessionRecord): AiSessionMetadata {
  return {
    id: session.id,
    name: session.name,
    agent: session.agent,
    cwd: session.cwd,
    status: session.status,
    groupId: session.groupId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.cliSessionId ? { cliSessionId: session.cliSessionId } : {}),
    ...(session.model ? { model: session.model } : {}),
    ...(session.guiAgent ? { guiAgent: session.guiAgent } : {}),
    ...(session.guiModel ? { guiModel: session.guiModel } : {}),
    ...(session.agentConfig ? { agentConfig: session.agentConfig } : {}),
    ...(session.agentConfigInitialized ? { agentConfigInitialized: true } : {}),
    pinned: session.pinned,
  };
}

export function groupsForDisplay(groups: AiSessionGroup[]): AiSessionGroup[] {
  return groups
    .map((group, index) => ({ group, index }))
    .sort((left, right) => {
      if ((left.group.pinned === true) !== (right.group.pinned === true)) {
        return left.group.pinned === true ? -1 : 1;
      }
      return left.group.createdAt - right.group.createdAt || left.index - right.index;
    })
    .map(({ group }) => group);
}

export function groupsByDeletionState(groups: AiSessionGroup[], deleted: boolean): AiSessionGroup[] {
  return groupsForDisplay(groups.filter((group) => (group.deletedAt !== undefined) === deleted));
}

export function sessionsForGroup(
  sessions: AiSessionMetadata[],
  groupId: string | null,
): AiSessionMetadata[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .filter(({ session }) => session.groupId === groupId)
    .sort((left, right) => {
      if (left.session.pinned !== right.session.pinned) {
        return left.session.pinned ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map(({ session }) => session);
}

export function moveSession(
  sessions: AiSessionMetadata[],
  sessionId: string,
  groupId: string | null,
  now = Date.now(),
): AiSessionMetadata[] {
  const targetIndex = sessions.findIndex((session) => session.id === sessionId);
  if (targetIndex < 0 || sessions[targetIndex].groupId === groupId) {
    return sessions;
  }
  return sessions.map((session, index) => (
    index === targetIndex ? { ...session, groupId, updatedAt: now } : session
  ));
}

export function featureWindowStateKey(featureId: string, groupId: string | null): string {
  return `${featureId}::${groupId ?? '__ungrouped__'}`;
}

export function upsertFeatureWindowStepState(
  states: FeatureWindowStepState[],
  featureId: string,
  groupId: string | null,
  done: Record<number, boolean>,
  now = Date.now(),
): FeatureWindowStepState[] {
  const key = featureWindowStateKey(featureId, groupId);
  const nextState = { featureId, groupId, done: compactDone(done), updatedAt: now };
  let replaced = false;
  const next = states.map((state) => {
    if (featureWindowStateKey(state.featureId, state.groupId) !== key) {
      return state;
    }
    replaced = true;
    return nextState;
  });
  return replaced ? next : [...next, nextState];
}

function normalizeGroups(value: unknown): AiSessionGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const names = new Set<string>();
  const groups: AiSessionGroup[] = [];
  for (const candidate of value) {
    if (!isAiSessionGroup(candidate)) {
      continue;
    }
    const name = candidate.name.trim();
    if (!name || names.has(name)) {
      continue;
    }
    names.add(name);
    groups.push({
      ...candidate,
      name,
      pinned: candidate.pinned === true,
      ...(isFiniteNumber(candidate.deletedAt) ? { deletedAt: candidate.deletedAt } : {}),
    });
  }
  return groups;
}

function normalizeFeatureWindowStates(
  value: unknown,
  groupIds: Set<string>,
): FeatureWindowStepState[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const states: FeatureWindowStepState[] = [];
  for (const candidate of value) {
    if (!isObject(candidate) || typeof candidate.featureId !== 'string' || !candidate.featureId.trim()) {
      continue;
    }
    const groupId = typeof candidate.groupId === 'string'
      ? candidate.groupId
      : candidate.groupId === null
        ? null
        : undefined;
    if (groupId === undefined || (groupId !== null && !groupIds.has(groupId))) {
      continue;
    }
    if (!isFiniteNumber(candidate.updatedAt)) {
      continue;
    }
    const key = featureWindowStateKey(candidate.featureId, groupId);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    states.push({
      featureId: candidate.featureId,
      groupId,
      done: compactDone(candidate.done),
      updatedAt: candidate.updatedAt,
    });
  }
  return states;
}

function compactDone(value: unknown): Record<number, boolean> {
  if (!isObject(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([index, done]) => /^\d+$/.test(index) && done === true)
      .map(([index]) => [Number(index), true]),
  );
}

function normalizeSession(
  value: unknown,
  legacy: boolean,
  groupIds: Set<string>,
): AiSessionMetadata | undefined {
  if (!isObject(value) || !isAgent(value.agent)) {
    return undefined;
  }
  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.cwd !== 'string' ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt)
  ) {
    return undefined;
  }

  const groupId = !legacy && typeof value.groupId === 'string' && groupIds.has(value.groupId)
    ? value.groupId
    : null;
  const cliSessionId = normalizeSessionUuid(value.cliSessionId);
  const guiAgent = normalizeGuiAgent(value.guiAgent ?? value.guiModel);
  const guiModel = normalizeGuiModel(value.guiModel);
  const agentConfig = normalizeAgentConfig(value.agentConfig);
  return {
    id: value.id,
    name: value.name,
    agent: value.agent,
    cwd: value.cwd,
    status: 'stopped',
    groupId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(cliSessionId ? { cliSessionId } : {}),
    ...(typeof value.model === 'string' && value.model.trim() ? { model: value.model.trim() } : {}),
    ...(guiAgent ? { guiAgent } : {}),
    ...(guiModel ? { guiModel } : {}),
    ...(agentConfig ? { agentConfig } : {}),
    ...(agentConfig && value.agentConfigInitialized === true ? { agentConfigInitialized: true } : {}),
    pinned: value.pinned === true,
  };
}

function normalizeAgentConfig(value: unknown): AgentSessionConfig | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const stringList = (candidate: unknown) => Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === 'string')
    : undefined;
  const config: AgentSessionConfig = {
    ...(typeof value.agentId === 'string' ? { agentId: value.agentId } : {}),
    ...(typeof value.agentName === 'string' ? { agentName: value.agentName } : {}),
    ...(typeof value.model === 'string' && value.model.trim() ? { model: value.model.trim() } : {}),
    ...(typeof value.systemPrompt === 'string' ? { systemPrompt: value.systemPrompt } : {}),
    ...(stringList(value.behaviorRules) ? { behaviorRules: stringList(value.behaviorRules) } : {}),
    ...(stringList(value.skills) ? { skills: stringList(value.skills) } : {}),
    ...(stringList(value.knowledgeBases) ? { knowledgeBases: stringList(value.knowledgeBases) } : {}),
    ...(stringList(value.mcps) ? { mcps: stringList(value.mcps) } : {}),
  };
  return Object.keys(config).length ? config : undefined;
}

function isAiSessionGroup(value: unknown): value is AiSessionGroup {
  return isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    isFiniteNumber(value.createdAt) &&
    typeof value.collapsed === 'boolean';
}

function isAgent(value: unknown): value is AgentType {
  return value === 'claude' || value === 'codex' || value === 'terminal' || value === 'gui';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
