import { Bot, Check, ChevronDown, Copy, FileCode2, FolderOpen, Send, Sparkles, TerminalSquare, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AgentDefinition } from './AgentCenterDemo';

export function AgentSessionDemo({ agent, onBack }: { agent: AgentDefinition; onBack: () => void }) {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState(() => [
    { role: 'system', text: `已加载 Agent「${agent.name}」配置。会话将使用 ${agent.model}，工作目录为 ${agent.cwd}。` },
    { role: 'assistant', text: `你好，我是${agent.name}。我会按照预设角色工作，并优先使用已关联的 Skill、知识库和 MCP 来分析问题。\n\n你可以直接描述要处理的任务。` },
  ]);
  const skills = agent.skillNames?.length ? agent.skillNames : agent.capabilities;
  const resources = agent.knowledgeBases?.length ? agent.knowledgeBases : [agent.cwd];
  const submit = () => {
    const value = input.trim();
    if (!value) return;
    setMessages((current) => [...current, { role: 'user', text: value }, { role: 'assistant', text: `已收到任务。我会以「${agent.name}」的规则处理，并结合 ${skills.length} 个 Skill 和 ${resources.length} 个知识资源给出结果。\n\n这是 Demo 回复，真实版本会连接当前 Agent 会话的终端或 GUI 引擎。` }]);
    setInput('');
  };
  const configItems = useMemo(() => [
    { label: '模型', value: agent.model, icon: <Sparkles size={14} /> },
    { label: '工作目录', value: agent.cwd, icon: <FolderOpen size={14} /> },
    { label: 'MCP', value: agent.mcps?.length ? `${agent.mcps.length} 个服务` : '未配置', icon: <TerminalSquare size={14} /> },
  ], [agent]);
  return <section className="agent-session-demo"><header className="agent-session-demo-header"><div className="agent-session-demo-title"><button aria-label="返回 Agent 中心" className="icon-button" onClick={onBack} title="返回 Agent 中心" type="button"><X size={17} /></button><span className="agent-avatar" style={{ background: agent.color }}><Bot size={17} /></span><div><strong>{agent.name}</strong><small>Agent 会话 · 配置已加载</small></div></div><div className="agent-session-demo-actions"><span className="agent-session-status"><Check size={13} />运行中</span><button className="secondary-button" onClick={() => void navigator.clipboard?.writeText(agent.prompt)} type="button"><Copy size={14} />复制 Agent 规则</button></div></header><div className="agent-session-demo-grid"><aside className="agent-session-config"><section className="agent-session-profile"><span className="agent-avatar large" style={{ background: agent.color }}><Bot size={22} /></span><h2>{agent.name}</h2><p>{agent.description}</p><span className="agent-pill blue">{agent.type === 'claude' ? 'Claude' : agent.type === 'codex' ? 'Codex' : 'GUI'}</span></section><section className="agent-session-config-section"><h3>Agent 配置</h3>{configItems.map((item) => <div className="agent-session-config-row" key={item.label}><span>{item.icon}{item.label}</span><strong title={item.value}>{item.value}</strong></div>)}</section><section className="agent-session-config-section"><h3>已加载 Skill <small>{skills.length}</small></h3><div className="agent-session-chip-list">{skills.map((skill) => <span key={skill}><Sparkles size={12} />{skill}</span>)}</div></section><section className="agent-session-config-section"><h3>知识库 / 资源 <small>{resources.length}</small></h3>{resources.map((resource) => <div className="agent-session-resource" key={resource}><FileCode2 size={14} /><span title={resource}>{resource}</span></div>)}</section><section className="agent-session-config-section"><h3>系统提示词</h3><p className="agent-session-prompt">{agent.prompt}</p></section></aside><main className="agent-session-chat"><div className="agent-session-chat-toolbar"><span><TerminalSquare size={15} />交互窗口</span><small>Agent 配置会作为当前会话上下文生效</small></div><div className="agent-session-messages">{messages.map((message, index) => <article className={`agent-session-message ${message.role}`} key={`${message.role}-${index}`}><span className="agent-session-message-role">{message.role === 'user' ? '我' : message.role === 'system' ? '系统' : agent.name}</span><div>{message.text.split('\n').map((line, lineIndex) => <p key={lineIndex}>{line || '\u00a0'}</p>)}</div></article>)}</div><div className="agent-session-composer"><textarea aria-label="Agent 会话输入框" onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder="输入任务，Enter 发送，Shift + Enter 换行" value={input} /><button aria-label="发送" className="primary-button" onClick={submit} type="button"><Send size={16} />发送</button><div className="agent-session-composer-hint">已注入：{skills.length} 个 Skill · {resources.length} 个知识资源 · {agent.mcps?.length ?? 0} 个 MCP</div></div></main></div></section>;
}
