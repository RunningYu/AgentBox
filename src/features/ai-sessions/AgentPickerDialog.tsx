import { Bot, FolderOpen, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AgentSessionConfig, AgentType, GuiAgentType, GuiModelType } from '../../shared/types';

export interface AgentPickerOption {
  id: string;
  name: string;
  description: string;
  type: 'claude' | 'codex' | 'gui';
  model: string;
  cwd: string;
  guiAgent?: GuiAgentType;
  guiModel?: GuiModelType;
  agent: AgentType;
  color: string;
  agentConfig?: AgentSessionConfig;
  prompt?: string;
  behaviorRules?: string[];
  capabilities?: string[];
  skillNames?: string[];
  knowledgeBases?: string[];
  mcps?: string[];
}

const STORAGE_KEY = 'agentbox.agent-center.v1';

export function loadAgentPickerOptions(): AgentPickerOption[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<AgentPickerOption>[] : [];
    return parsed.filter((item) => typeof item.id === 'string' && typeof item.name === 'string' && typeof item.cwd === 'string')
      .map((item) => {
        const type = item.type ?? 'claude';
        const model = item.model ?? '';
        const existingConfig = item.agentConfig ?? {};
        return {
          ...item,
          description: item.description ?? '',
          type,
          model,
          agent: type,
          color: item.color ?? '#3f82d8',
          agentConfig: {
            ...existingConfig,
            agentId: existingConfig.agentId ?? item.id,
            agentName: existingConfig.agentName ?? item.name,
            model: existingConfig.model ?? model,
            systemPrompt: existingConfig.systemPrompt ?? item.prompt,
            behaviorRules: existingConfig.behaviorRules ?? item.behaviorRules,
            skills: existingConfig.skills ?? item.skillNames ?? item.capabilities,
            knowledgeBases: existingConfig.knowledgeBases ?? item.knowledgeBases,
            mcps: existingConfig.mcps ?? item.mcps,
          },
        };
      }) as AgentPickerOption[];
  } catch {
    return [];
  }
}

export function AgentPickerDialog({ onCancel, onSelect }: { onCancel: () => void; onSelect: (agent: AgentPickerOption) => void }) {
  const [query, setQuery] = useState('');
  const options = useMemo(() => loadAgentPickerOptions().filter((agent) => `${agent.name} ${agent.description}`.toLowerCase().includes(query.toLowerCase())), [query]);
  return <div className="modal-backdrop"><section aria-label="选择 Agent" className="agent-picker-dialog"><header><div><h2>从 Agent 创建会话</h2><p>选择配置后，会话将创建在当前分组中</p></div><button aria-label="关闭" className="icon-button" onClick={onCancel} type="button"><X size={17} /></button></header><input aria-label="搜索 Agent" className="agent-picker-search" onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Agent" value={query} /><div className="agent-picker-list">{options.map((agent) => <button className="agent-picker-item" key={agent.id} onClick={() => onSelect(agent)} type="button"><span className="agent-avatar" style={{ background: agent.color }}><Bot size={16} /></span><span><strong>{agent.name}</strong><small>{agent.type === 'claude' ? 'Claude' : agent.type === 'codex' ? 'Codex' : 'GUI'} · {agent.model}</small><em><FolderOpen size={12} />{agent.cwd}</em></span></button>)}{options.length === 0 && <p className="agent-empty">还没有可用的 Agent 配置，请先在 Agent 中心创建</p>}</div></section></div>;
}
