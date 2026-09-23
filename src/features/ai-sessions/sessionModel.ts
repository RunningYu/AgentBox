import type { AgentSessionConfig, AgentType, AiSessionRecord, GuiAgentType, GuiModelType } from '../../shared/types';

export const MAX_HISTORY_LENGTH = 10_000_000;
const TERMINAL_RESET = '\u001bc\u001b[2J\u001b[H';
const TERMINAL_SYNC_START = '\u001b[?2026h';

interface CreateAiSessionInput {
  id: string;
  name: string;
  agent: AgentType;
  cwd: string;
  now: number;
  groupId?: string | null;
  model?: string;
  guiAgent?: GuiAgentType;
  guiModel?: GuiModelType;
  agentConfig?: AgentSessionConfig;
}

export function createAiSession(input: CreateAiSessionInput): AiSessionRecord {
  return {
    id: input.id,
    name: input.name.trim(),
    agent: input.agent,
    cwd: input.cwd.trim(),
    status: 'running',
    groupId: input.groupId ?? null,
    history: '',
    createdAt: input.now,
    updatedAt: input.now,
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    guiAgent: input.agent === 'gui' ? input.guiAgent ?? 'claude' : undefined,
    guiModel: input.agent === 'gui' ? input.guiModel ?? defaultGuiModel(input.guiAgent ?? 'claude') : undefined,
    pinned: false,
    ...(input.agentConfig ? { agentConfig: input.agentConfig, agentConfigInitialized: false } : {}),
  };
}

export function restoreAiSessions(value: unknown): AiSessionRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isAiSessionRecord).map((session) => ({
    id: session.id,
    name: session.name,
    agent: session.agent,
    cwd: session.cwd,
    status: 'stopped',
    groupId: typeof session.groupId === 'string' ? session.groupId : null,
    history: appendSessionHistory('', session.history),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cliSessionId: normalizeSessionUuid(session.cliSessionId),
    ...(typeof session.model === 'string' && session.model.trim() ? { model: session.model.trim() } : {}),
    guiAgent: normalizeGuiAgent(session.guiAgent ?? session.guiModel),
    guiModel: normalizeGuiModel(session.guiModel),
    pinned: session.pinned === true,
    ...(session.agentConfig ? { agentConfig: session.agentConfig, agentConfigInitialized: session.agentConfigInitialized === true } : {}),
  }));
}

export function sortAiSessions(sessions: AiSessionRecord[]): AiSessionRecord[] {
  return [...sessions].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }
    return 0;
  });
}

export interface ParsedResumeSession {
  agent?: AgentType;
  cliSessionId: string;
}

export function parseResumeSessionInput(value: string): ParsedResumeSession | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  const cliSessionId = normalizeSessionUuid(normalized) ??
    normalized
      .split(/\s+/)
      .map((part) => normalizeSessionUuid(part))
      .find((part): part is string => Boolean(part));
  if (!cliSessionId) {
    return undefined;
  }
  const lower = normalized.toLowerCase();
  const agent = lower.includes('codex')
    ? 'codex'
    : lower.includes('claude')
      ? 'claude'
      : undefined;
  return { agent, cliSessionId };
}

export function appendSessionHistory(
  current: string,
  output: string,
  limit = MAX_HISTORY_LENGTH,
): string {
  const combined = `${current}${output}`;
  if (combined.length <= limit) {
    return combined;
  }
  const tail = combined.slice(-limit);
  const frameOffset = tail.indexOf(TERMINAL_SYNC_START);
  if (frameOffset < 0) {
    return tail;
  }
  const framedTail = tail.slice(frameOffset);
  return `${TERMINAL_RESET}${framedTail}`;
}

export function applySessionOutput(
  session: AiSessionRecord,
  generation: string,
  output: string,
  now: number,
): AiSessionRecord {
  if (session.status !== 'running' || session.generation !== generation) {
    return session;
  }
  return {
    ...session,
    history: appendSessionHistory(session.history, output),
    updatedAt: now,
  };
}

function isAiSessionRecord(value: unknown): value is AiSessionRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<AiSessionRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    (record.agent === 'claude' || record.agent === 'codex' || record.agent === 'terminal' || record.agent === 'gui') &&
    typeof record.cwd === 'string' &&
    typeof record.history === 'string' &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt) &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt)
  );
}

export function normalizeSessionUuid(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : undefined;
}

export function normalizeGuiModel(value: unknown): GuiModelType | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeGuiAgent(value: unknown): GuiAgentType | undefined {
  return value === 'codex' || value === 'claude' ? value : undefined;
}

export function defaultGuiModel(agent: GuiAgentType): string {
  return agent === 'codex' ? 'gpt-5.6-sol' : 'sonnet';
}
