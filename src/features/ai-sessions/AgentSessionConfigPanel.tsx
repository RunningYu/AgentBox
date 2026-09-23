import { Bot, BrainCircuit, Check, Database, FolderOpen, ServerCog, Sparkles } from 'lucide-react';
import type { AgentSessionConfig, AgentType } from '../../shared/types';

function agentLabel(agent: AgentType) {
  return agent === 'claude' ? 'Claude Code' : agent === 'codex' ? 'Codex' : agent === 'gui' ? 'GUI Agent' : '终端';
}

export function AgentSessionConfigPanel({ agent, config, cwd, initialized }: { agent: AgentType; config: AgentSessionConfig; cwd: string; initialized: boolean }) {
  const skills = config.skills ?? [];
  const resources = config.knowledgeBases ?? [];
  const mcps = config.mcps ?? [];
  const behaviorRules = config.behaviorRules ?? [];
  return <aside className="agent-session-config-panel" aria-label="Agent 会话配置">
    <header className="agent-session-config-profile">
      <span className="agent-session-config-avatar"><Bot size={18} /></span>
      <div><strong>{config.agentName ?? 'Agent 会话'}</strong><small>{agentLabel(agent)} · {initialized ? '上下文已注入' : '待首次任务注入'}</small></div>
    </header>
    <section>
      <h3><BrainCircuit size={14} />会话上下文</h3>
      <div className={`agent-session-context-status ${initialized ? 'initialized' : ''}`}><span />{initialized ? 'Agent 配置已注入当前 CLI 会话' : '首次发送任务时注入 Agent 配置'}</div>
      {config.model && <div className="agent-session-context-row"><span>模型</span><strong title={config.model}>{config.model}</strong></div>}
      <div className="agent-session-context-row"><span><FolderOpen size={13} />工作目录</span><strong title={cwd}>{cwd}</strong></div>
      <div className="agent-session-context-row"><span><ServerCog size={13} />MCP</span><strong>{mcps.length ? `${mcps.length} 个服务` : '未配置'}</strong></div>
    </section>
    <section>
      <h3><Sparkles size={14} />行为规则 <small>{behaviorRules.length}</small></h3>
      {behaviorRules.length ? <div className="agent-session-config-rules">{behaviorRules.map((rule) => <div className="agent-session-config-row" key={rule}><span><Check size={13} />规则</span><strong title={rule}>{rule}</strong></div>)}</div> : <p>未配置行为规则</p>}
    </section>
    <section>
      <h3><Sparkles size={14} />已加载 Skill <small>{skills.length}</small></h3>
      {skills.length ? <div className="agent-session-config-chips">{skills.map((skill) => <span key={skill}>{skill}</span>)}</div> : <p>未配置 Skill</p>}
    </section>
    <section>
      <h3><Database size={14} />知识库 / 资源 <small>{resources.length}</small></h3>
      {resources.length ? <div className="agent-session-resource-list">{resources.map((resource) => <span key={resource} title={resource}>{resource}</span>)}</div> : <p>未配置知识库或文档资源</p>}
    </section>
    <section>
      <h3>系统提示词</h3>
      <p className="agent-session-system-prompt">{config.systemPrompt || '未配置系统提示词'}</p>
    </section>
  </aside>;
}
