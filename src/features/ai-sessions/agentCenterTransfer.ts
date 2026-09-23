import { invoke } from '@tauri-apps/api/core';
import type { AgentDefinition } from './AgentCenterDemo';

export type AgentCenterConflictStrategy = 'skip' | 'overwrite' | 'duplicate';

export interface AgentCenterExportPayload {
  app: 'agentbox';
  scope: 'agent-center';
  schemaVersion: 1;
  exportedAt: string;
  agents: AgentDefinition[];
}

export interface AgentCenterImportPreview {
  path: string;
  payload: AgentCenterExportPayload;
  agents: AgentDefinition[];
  added: AgentDefinition[];
  conflicted: AgentDefinition[];
  invalidCount: number;
}

export interface AgentCenterImportResult {
  agents: AgentDefinition[];
  addedCount: number;
  overwrittenCount: number;
  skippedCount: number;
  duplicatedCount: number;
}

interface ImportedAgentCenterFile {
  path: string;
  content: string;
}

const AGENT_CENTER_APP = 'agentbox';
const AGENT_CENTER_SCHEMA_VERSION = 1;
const DEFAULT_AGENT_COLOR = '#3f82d8';

export function createAgentCenterExportPayload(agents: AgentDefinition[]): AgentCenterExportPayload {
  return {
    app: AGENT_CENTER_APP,
    scope: 'agent-center',
    schemaVersion: AGENT_CENTER_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    agents: agents.map(cloneAgent),
  };
}

export function exportAgentCenterConfig(defaultName: string, payload: AgentCenterExportPayload): Promise<string | null> {
  const fileName = defaultName.trim() || `AgentBox-agents-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`;
  return invoke<string | null>('export_agent_center_config', {
    defaultName: fileName,
    content: `${JSON.stringify(payload, null, 2)}\n`,
  });
}

export async function chooseAgentCenterImportFile(existingAgents: AgentDefinition[]): Promise<AgentCenterImportPreview | null> {
  const file = await invoke<ImportedAgentCenterFile | null>('choose_agent_center_import_file');
  if (!file) {
    return null;
  }
  return parseAgentCenterImportFile(file.path, file.content, existingAgents);
}

export function parseAgentCenterImportFile(path: string, content: string, existingAgents: AgentDefinition[]): AgentCenterImportPreview {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error('导入文件不是有效 JSON');
  }
  const payload = normalizePayload(raw);
  const normalized = payload.agents.map(normalizeAgent).filter((agent): agent is AgentDefinition => Boolean(agent));
  const invalidCount = payload.agents.length - normalized.length;
  const existingIds = new Set(existingAgents.map((agent) => agent.id));
  const existingNames = new Set(existingAgents.map((agent) => normalizeKey(agent.name)));
  const conflicted = normalized.filter((agent) => existingIds.has(agent.id) || existingNames.has(normalizeKey(agent.name)));
  const added = normalized.filter((agent) => !existingIds.has(agent.id) && !existingNames.has(normalizeKey(agent.name)));
  return {
    path,
    payload: { ...payload, agents: normalized.map(cloneAgent) },
    agents: normalized,
    added,
    conflicted,
    invalidCount,
  };
}

export function applyAgentCenterImport(
  preview: AgentCenterImportPreview,
  existingAgents: AgentDefinition[],
  strategy: AgentCenterConflictStrategy,
): AgentCenterImportResult {
  const nextAgents = existingAgents.map(cloneAgent);
  const existingById = new Map(nextAgents.map((agent) => [agent.id, agent]));
  const existingByName = new Map(nextAgents.map((agent) => [normalizeKey(agent.name), agent]));
  let addedCount = 0;
  let overwrittenCount = 0;
  let skippedCount = 0;
  let duplicatedCount = 0;

  for (const agent of preview.agents) {
    const existing = existingById.get(agent.id) ?? existingByName.get(normalizeKey(agent.name));
    if (existing) {
      if (strategy === 'skip') {
        skippedCount += 1;
        continue;
      }
      if (strategy === 'overwrite') {
        const replacement = normalizeAgent({ ...cloneAgent(agent), id: existing.id });
        if (replacement) {
          const index = nextAgents.findIndex((item) => item.id === existing.id);
          if (index >= 0) {
            nextAgents[index] = replacement;
          }
          existingById.set(replacement.id, replacement);
          existingByName.set(normalizeKey(replacement.name), replacement);
        }
        overwrittenCount += 1;
        continue;
      }
      const duplicated = normalizeAgent({
        ...cloneAgent(agent),
        id: uniqueAgentId(agent.id, nextAgents),
        name: uniqueAgentName(`${agent.name} 导入`, nextAgents),
      });
      if (duplicated) {
        nextAgents.push(duplicated);
        existingById.set(duplicated.id, duplicated);
        existingByName.set(normalizeKey(duplicated.name), duplicated);
      }
      duplicatedCount += 1;
      continue;
    }
    const created = normalizeAgent({
      ...cloneAgent(agent),
      id: uniqueAgentId(agent.id, nextAgents),
    });
    if (created) {
      nextAgents.push(created);
      existingById.set(created.id, created);
      existingByName.set(normalizeKey(created.name), created);
    }
    addedCount += 1;
  }

  return {
    agents: nextAgents,
    addedCount,
    overwrittenCount,
    skippedCount,
    duplicatedCount,
  };
}

function normalizePayload(raw: unknown): AgentCenterExportPayload {
  if (!raw || typeof raw !== 'object') {
    throw new Error('导入文件格式不正确');
  }
  const value = raw as Partial<AgentCenterExportPayload>;
  if (value.app !== AGENT_CENTER_APP || value.scope !== 'agent-center' || value.schemaVersion !== AGENT_CENTER_SCHEMA_VERSION || !Array.isArray(value.agents)) {
    throw new Error('导入文件不是 AgentBox Agent 配置，或版本暂不支持');
  }
  return {
    app: AGENT_CENTER_APP,
    scope: 'agent-center',
    schemaVersion: AGENT_CENTER_SCHEMA_VERSION,
    exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : '',
    agents: value.agents.filter((agent): agent is AgentDefinition => isAgentLike(agent)).map(cloneAgent),
  };
}

function normalizeAgent(value: unknown): AgentDefinition | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) {
    return undefined;
  }
  const type = isAgentType(value.type) ? value.type : 'claude';
  const skillNames = stringList(value.skillNames) ?? stringList(value.capabilities) ?? [];
  const capabilities = stringList(value.capabilities) ?? [...skillNames];
  const cwd = typeof value.cwd === 'string' && value.cwd.trim() ? value.cwd.trim() : '/tmp/agentbox-project';
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `agent-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const updated = typeof value.updated === 'string' && value.updated.trim() ? value.updated.trim() : '刚刚';
  const guiAgent = type === 'gui' ? (value.guiAgent === 'codex' ? 'codex' : 'claude') : undefined;
  const guiModel = type === 'gui'
    ? (typeof value.guiModel === 'string' && value.guiModel.trim() ? value.guiModel.trim() : 'claude-sonnet-4-6')
    : undefined;
  return {
    id,
    name,
    description: typeof value.description === 'string' ? value.description : '',
    type,
    model: typeof value.model === 'string' && value.model.trim()
      ? value.model.trim()
      : defaultAgentModel(type),
    skills: typeof value.skills === 'number' && Number.isFinite(value.skills) ? value.skills : Math.max(skillNames.length, capabilities.length),
    sessions: typeof value.sessions === 'number' && Number.isFinite(value.sessions) ? value.sessions : 0,
    updated,
    color: typeof value.color === 'string' && value.color.trim() ? value.color.trim() : DEFAULT_AGENT_COLOR,
    cwd,
    group: typeof value.group === 'string' ? value.group : '未分组',
    prompt: typeof value.prompt === 'string' ? value.prompt : '',
    behaviorRules: stringList(value.behaviorRules),
    capabilities,
    skillNames: skillNames.length ? skillNames : undefined,
    knowledgeBases: stringList(value.knowledgeBases),
    mcps: stringList(value.mcps),
    ...(guiAgent ? { guiAgent } : {}),
    ...(guiModel ? { guiModel } : {}),
  };
}

function defaultAgentModel(type: AgentDefinition['type']): string {
  if (type === 'codex') return 'gpt-5.5';
  if (type === 'gui') return 'Claude Sonnet 4.6';
  return 'Claude Sonnet 4.6';
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : undefined;
}

function cloneAgent(agent: AgentDefinition): AgentDefinition {
  return {
    ...agent,
    capabilities: [...agent.capabilities],
    behaviorRules: agent.behaviorRules ? [...agent.behaviorRules] : undefined,
    skillNames: agent.skillNames ? [...agent.skillNames] : undefined,
    knowledgeBases: agent.knowledgeBases ? [...agent.knowledgeBases] : undefined,
    mcps: agent.mcps ? [...agent.mcps] : undefined,
  };
}

function isAgentLike(value: unknown): value is AgentDefinition {
  return isObject(value) && typeof value.name === 'string' && typeof value.cwd === 'string';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isAgentType(value: unknown): value is AgentDefinition['type'] {
  return value === 'claude' || value === 'codex' || value === 'gui';
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueAgentId(baseId: string, agents: AgentDefinition[]): string {
  const ids = new Set(agents.map((agent) => agent.id));
  const cleanBase = baseId.trim() || `imported-${Date.now()}`;
  if (!ids.has(cleanBase)) {
    return cleanBase;
  }
  let index = 2;
  while (ids.has(`${cleanBase}-${index}`)) {
    index += 1;
  }
  return `${cleanBase}-${index}`;
}

function uniqueAgentName(baseName: string, agents: AgentDefinition[]): string {
  const names = new Set(agents.map((agent) => normalizeKey(agent.name)));
  const cleanBase = baseName.trim();
  if (!names.has(normalizeKey(cleanBase))) {
    return cleanBase;
  }
  let index = 2;
  while (names.has(normalizeKey(`${cleanBase} ${index}`))) {
    index += 1;
  }
  return `${cleanBase} ${index}`;
}
