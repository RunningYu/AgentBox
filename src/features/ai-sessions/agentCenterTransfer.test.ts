import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from './AgentCenterDemo';
import { applyAgentCenterImport, createAgentCenterExportPayload, parseAgentCenterImportFile } from './agentCenterTransfer';

const baseAgent: AgentDefinition = {
  id: 'requirement',
  name: '需求分析 Agent',
  description: '拆解需求',
  type: 'claude',
  model: 'Claude Sonnet 4.6',
  skills: 2,
  sessions: 3,
  updated: '今天 10:35',
  color: '#3f82d8',
  cwd: '/tmp/agentbox-project',
  group: '需求分析',
  prompt: '你是一名需求分析师。',
  behaviorRules: ['先确认目标'],
  capabilities: ['需求拆解'],
  skillNames: ['需求拆解'],
  knowledgeBases: ['/tmp/agentbox-project'],
  mcps: ['mcp-a'],
};

describe('agentCenterTransfer', () => {
  it('exports current agent configs with the agent-center schema', () => {
    const payload = createAgentCenterExportPayload([baseAgent]);

    expect(payload.app).toBe('agentbox');
    expect(payload.scope).toBe('agent-center');
    expect(payload.schemaVersion).toBe(1);
    expect(payload.agents).toHaveLength(1);
    expect(payload.agents[0]).toEqual(baseAgent);
  });

  it('parses and applies imported agent configs with conflict handling', () => {
    const existing = [baseAgent];
    const preview = parseAgentCenterImportFile('/tmp/agents.json', JSON.stringify({
      app: 'agentbox',
      scope: 'agent-center',
      schemaVersion: 1,
      exportedAt: '2026-09-08T00:00:00.000Z',
      agents: [
        { ...baseAgent, id: 'remote-a', description: '远端版本', sessions: 99 },
        { ...baseAgent, id: 'incident', description: '新增 agent' },
      ],
    }), existing);

    expect(preview.conflicted).toHaveLength(2);
    expect(preview.added).toHaveLength(0);

    const skipped = applyAgentCenterImport(preview, existing, 'skip');
    expect(skipped.agents).toHaveLength(1);
    expect(skipped.skippedCount).toBe(2);

    const overwritten = applyAgentCenterImport(preview, existing, 'overwrite');
    expect(overwritten.agents).toHaveLength(1);
    expect(overwritten.overwrittenCount).toBe(2);
    expect(overwritten.agents[0].description).toBe('新增 agent');

    const duplicated = applyAgentCenterImport(preview, existing, 'duplicate');
    expect(duplicated.agents).toHaveLength(3);
    expect(duplicated.duplicatedCount).toBe(2);
    expect(duplicated.agents[1].name).toContain('导入');
  });

  it('rejects unsupported import files', () => {
    expect(() => parseAgentCenterImportFile('/tmp/bad.json', '{"agents":[]}', [])).toThrow(/Agent 配置/);
  });
});
