import { Bot, Check, ChevronDown, Copy, FileCode2, FolderOpen, GitBranch, MessageSquare, MoreHorizontal, Plus, Search, Settings2, Sparkles, TerminalSquare, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AgentSessionConfig, AgentType as SessionAgentType, GuiAgentType, GuiModelType } from '../../shared/types';
import { chooseWorkingDirectory, listAgentSkills, openWorkingDirectory, validateWorkingDirectory, type AgentSkillItem } from './terminalApi';
import { AgentSessionDemo } from './AgentSessionDemo';
import { AgentCenterTransferDialog } from './AgentCenterTransferDialog';
import { loadAiWorkspace } from '../../shared/promptpadStorage';
import type { AiWorkspaceArchive } from '../../shared/types';

type AgentCenterType = 'claude' | 'codex' | 'gui';
type AgentTab = 'summary' | 'basic' | 'behavior' | 'capabilities';

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  type: AgentCenterType;
  model: string;
  skills: number;
  sessions: number;
  updated: string;
  color: string;
  cwd: string;
  group: string;
  prompt: string;
  behaviorRules?: string[];
  capabilities: string[];
  skillNames?: string[];
  knowledgeBases?: string[];
  mcps?: string[];
  guiAgent?: GuiAgentType;
  guiModel?: GuiModelType;
  reviewDemo?: CodeReviewDemoConfig;
}

interface CodeReviewDemoConfig {
  inputs: { title: string; description: string }[];
  dimensions: string[];
  outputs: {
    kind: 'confirmed' | 'risk';
    severity: '严重' | '中等' | '低';
    file: string;
    line: string;
    title: string;
    reason: string;
    reproduce: string;
    suggestion: string;
  }[];
}

const AGENTS: AgentDefinition[] = [
  {
    id: 'review',
    name: 'Code Review Agent',
    description: '面向 Git diff、上下文代码和项目规范做系统化代码审查，输出可定位、可复现、可执行的修改建议。',
    type: 'codex',
    model: 'gpt-5.5',
    skills: 6,
    sessions: 8,
    updated: '刚刚',
    color: '#8a63c7',
    cwd: '/tmp/agentbox-project',
    group: '代码审查',
    prompt: [
      '你是一名严格、务实、以证据为先的 Code Review Agent。',
      '你的任务是基于 Git diff、目标分支上下文、项目规范、测试结果和需求说明审查代码变更。',
      '优先报告确定性问题；对无法仅凭上下文确认的问题，必须标记为“需要人工确认的风险”。',
      '每条 Review 结论必须包含：文件、行号或代码范围、严重程度、问题原因、复现方式或触发条件、修改建议。',
      '如果没有发现确定问题，明确说明已检查的范围，并列出仍建议人工确认的风险点。',
    ].join('\n'),
    behaviorRules: [
      '先阅读 Git diff，再结合目标分支和上下文代码判断影响范围',
      '优先输出确定问题，不把风格偏好包装成缺陷',
      '安全、权限、数据泄露、兼容性和异常处理问题优先级高于代码风格',
      '每条问题必须给出文件、行号、严重程度、原因、复现方式和修改建议',
      '明确区分“确定问题”和“需要人工确认的风险”',
      '如果需要项目规范、测试结果或需求说明但输入缺失，先指出缺失对结论可信度的影响',
    ],
    capabilities: ['Git diff 审查', '上下文代码分析', '项目规范校验', '测试覆盖评估', '安全与权限风险识别', '无用代码识别'],
    skillNames: ['code-review', 'test-driven-development', 'systematic-debugging', 'verification-before-completion'],
    knowledgeBases: ['项目规范文档', '目标分支上下文代码', '变更单 / 需求说明', '测试结果报告'],
    mcps: ['git', 'filesystem'],
    reviewDemo: {
      inputs: [
        { title: 'Git diff', description: '待审查的本次代码变更，包含新增、删除和修改行。' },
        { title: '目标分支和上下文代码', description: '用于判断兼容性、调用链、边界条件和历史逻辑约束。' },
        { title: '项目规范', description: '包含代码风格、架构边界、安全权限、测试要求和发布约束。' },
        { title: '测试结果', description: '单测、集成测试、构建和静态检查结果，用于判断回归风险。' },
        { title: '变更单或需求说明', description: '用于确认实现是否偏离需求，以及是否存在越权修改。' },
      ],
      dimensions: ['正确性和边界条件', '兼容性和异常处理', '安全、权限和数据泄露', '性能和资源释放', '可维护性和复杂度', '测试覆盖', '无用代码或越权修改'],
      outputs: [
        {
          kind: 'confirmed',
          severity: '严重',
          file: 'src/auth/session.ts',
          line: 'L42-L58',
          title: '缺少权限边界校验，普通用户可能访问管理员数据',
          reason: 'diff 中新增的查询只校验了登录态，没有复用目标分支已有的角色校验逻辑。',
          reproduce: '使用普通账号调用新增接口，并传入 adminOnly=true，可返回非本人数据。',
          suggestion: '在进入查询前复用 assertAdminRole，补充普通用户、管理员和未登录三类测试。',
        },
        {
          kind: 'risk',
          severity: '中等',
          file: 'src/cache/userCache.ts',
          line: 'L87',
          title: '缓存失效策略可能与需求预期不一致',
          reason: '当前 diff 将 TTL 从 5 分钟调整为 1 小时，但需求说明未明确允许延迟生效。',
          reproduce: '修改用户权限后立即查询，可能继续读取旧缓存；需要结合业务可接受延迟确认。',
          suggestion: '请产品或服务负责人确认权限变更实时性要求；若要求实时，需在权限变更链路主动清理缓存。',
        },
      ],
    },
  },
  { id: 'requirement', name: '需求分析 Agent', description: '拆解需求、识别边界与风险，输出可执行的研发任务。', type: 'claude', model: 'Claude Sonnet 4.6', skills: 8, sessions: 12, updated: '今天 10:35', color: '#3f82d8', cwd: '/tmp/agentbox-project', group: '需求分析', prompt: '你是一名资深需求分析师。先澄清目标与约束，再输出结论、方案、风险和待办。', behaviorRules: ['先确认目标和约束', '优先参考已配置 Skill', '先给结论，再展开方案与风险'], capabilities: ['需求拆解', '风险识别', '生成待办', '文档上下文'] },
  { id: 'incident', name: '线上问题排查', description: '围绕日志、环境、链路和监控指标组织排查过程。', type: 'claude', model: 'Claude Opus 4.6', skills: 11, sessions: 5, updated: '2026-09-01', color: '#d97745', cwd: '/tmp/agentbox-project', group: '线上排查', prompt: '你负责组织线上故障排查。先确认现象和时间范围，再逐步收敛根因并记录证据。', behaviorRules: ['先确认现象、时间范围和影响面', '按日志、环境、链路、监控逐步排查', '记录证据和结论，避免跳步'], capabilities: ['日志查询', '环境识别', '链路分析', '监控查询'] },
  { id: 'docs', name: '技术文档助手', description: '阅读 Markdown、代码和 Mermaid，整理出结构化结论。', type: 'gui', model: 'Claude Sonnet 4.6', guiAgent: 'claude', guiModel: 'claude-sonnet-4-6', skills: 4, sessions: 3, updated: '2026-08-30', color: '#2b9b8c', cwd: '/tmp/agentbox-notes', group: '文档阅读', prompt: '请将技术材料整理为清晰的 Markdown，保留代码、表格和 Mermaid 的结构。', behaviorRules: ['优先保留原始结构和关键引用', '把复杂内容整理成清晰 Markdown', '必要时补充简短结论和待办'], capabilities: ['Markdown', 'Mermaid', '摘要', '上下文引用'] },
];
const AGENT_STORAGE_KEY = 'agentbox.agent-center.v1';

export interface AgentCenterDemoProps {
  onBack: () => void;
  onCreateSession?: (agent: AgentDefinition) => void;
}

export function AgentCenterDemo({ onBack, onCreateSession }: AgentCenterDemoProps) {
  const [agents, setAgents] = useState<AgentDefinition[]>(() => loadAgents());
  const [selectedId, setSelectedId] = useState(AGENTS[0].id);
  const [query, setQuery] = useState('');
  const [type, setType] = useState<'all' | AgentCenterType>('all');
  const [tab, setTab] = useState<AgentTab>('summary');
  const [message, setMessage] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [newAgentDraft, setNewAgentDraft] = useState<AgentDefinition | null>(null);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [draftsById, setDraftsById] = useState<Record<string, AgentDefinition>>({});
  const [menuAgentId, setMenuAgentId] = useState<string | null>(null);
  const [deletingAgent, setDeletingAgent] = useState<AgentDefinition | null>(null);
  const [sessionDemoOpen, setSessionDemoOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [workspaceArchive, setWorkspaceArchive] = useState<AiWorkspaceArchive | null>(null);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const selected = agents.find((agent) => agent.id === selectedId) ?? agents[0];
  const selectedReviewDemo = selected?.id === 'review' ? AGENTS.find((agent) => agent.id === 'review')?.reviewDemo : selected?.reviewDemo;
  const selectedDraft = selected ? draftsById[selected.id] ?? selected : null;
  const editingSelected = Boolean(editingAgentId && selected && editingAgentId === selected.id);
  const filtered = useMemo(() => agents.filter((agent) => (type === 'all' || agent.type === type) && `${agent.name} ${agent.description}`.toLowerCase().includes(query.toLowerCase())), [agents, query, type]);

  useEffect(() => {
    window.localStorage.setItem(AGENT_STORAGE_KEY, JSON.stringify(agents));
  }, [agents]);

  useEffect(() => {
    let cancelled = false;
    void loadAiWorkspace()
      .then((archive) => {
        if (cancelled) return;
        setWorkspaceArchive(archive);
        setWorkspaceLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setWorkspaceArchive(null);
        setWorkspaceLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (sessionDemoOpen) {
    return <AgentSessionDemo agent={selected} onBack={() => setSessionDemoOpen(false)} />;
  }

  function notify(text: string) {
    setMessage(text);
    window.setTimeout(() => setMessage(''), 1800);
  }

  function openCreateAgent() {
    setNewAgentDraft(null);
    setEditingAgentId(null);
    setMenuAgentId(null);
    setEditorOpen(true);
  }

  function openTemplateAgent() {
    setNewAgentDraft(cloneAgent({
      ...AGENTS[0],
      id: `agent-${Date.now()}`,
      name: '新 Agent',
      description: '从内置模板开始配置你的专属 Agent。',
      sessions: 0,
      updated: '刚刚',
    }));
    setEditingAgentId(null);
    setMenuAgentId(null);
    setEditorOpen(true);
  }

  function openCopyAgent(agent: AgentDefinition) {
    setNewAgentDraft({
      ...cloneAgent(agent),
      id: `agent-${Date.now()}`,
      name: `${agent.name}-复制`,
      sessions: 0,
      updated: '刚刚',
    });
    setEditingAgentId(null);
    setSelectedId(agent.id);
    setMenuAgentId(null);
    setEditorOpen(true);
  }

  function openEditAgent(agent: AgentDefinition) {
    setEditorOpen(false);
    setNewAgentDraft(null);
    setDraftsById((current) => ({
      ...current,
      [agent.id]: current[agent.id] ?? cloneAgent(agent),
    }));
    setEditingAgentId(agent.id);
    setSelectedId(agent.id);
    setTab('summary');
    setMenuAgentId(null);
  }

  function openDeleteAgent(agent: AgentDefinition) {
    setMenuAgentId(null);
    setDeletingAgent(agent);
  }

  function persistAgent(agent: AgentDefinition) {
    setAgents((current) => current.some((item) => item.id === agent.id)
      ? current.map((item) => (item.id === agent.id ? agent : item))
      : [...current, agent]);
  }

  function saveNewAgent(agent: AgentDefinition) {
    persistAgent({ ...agent, skills: agent.skillNames?.length ?? agent.capabilities.length });
    setSelectedId(agent.id);
    setEditorOpen(false);
    setNewAgentDraft(null);
    notify('Agent 配置已保存');
  }

  function saveEditedAgent(agent: AgentDefinition) {
    persistAgent({ ...agent, skills: agent.skillNames?.length ?? agent.capabilities.length });
    setDraftsById((current) => {
      const next = { ...current };
      delete next[agent.id];
      return next;
    });
    setEditingAgentId(null);
    setSelectedId(agent.id);
    notify('Agent 配置已保存');
  }

  function cancelEditing(agentId: string) {
    setDraftsById((current) => {
      const next = { ...current };
      delete next[agentId];
      return next;
    });
    setEditingAgentId(null);
  }

  async function removeAgent(agent: AgentDefinition) {
    if (agents.length === 1) {
      notify('至少保留一个 Agent 配置');
      return;
    }
    setAgents((current) => current.filter((item) => item.id !== agent.id));
    setDraftsById((current) => {
      const next = { ...current };
      delete next[agent.id];
      return next;
    });
    if (editingAgentId === agent.id) {
      setEditingAgentId(null);
    }
    setMenuAgentId(null);
    if (selectedId === agent.id) {
      setSelectedId(agents.find((item) => item.id !== agent.id)?.id ?? '');
    }
    setDeletingAgent(null);
    notify('Agent 已删除，历史会话已保留');
  }

  const selectedSkillCount = selected.skillNames?.length ?? selected.capabilities.length;
  const selectedSummary = buildAgentSummary(selected, workspaceArchive);
  const deletingAgentSessionCount = deletingAgent
    ? (workspaceArchive?.sessions ?? []).filter((session) => matchesAgentSession(session, deletingAgent)).length
    : 0;
  const handleAgentCenterBack = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onBack();
  };

  return <section className="agent-center-demo" aria-label="Agent 中心 Demo">
    <header className="agent-center-header">
      <div className="agent-center-title"><button className="icon-button" aria-label="返回 AI 工作台" data-testid="agent-center-back" onClick={handleAgentCenterBack} title="返回" type="button"><X size={17} /></button><div><strong>Agent 中心</strong><span>将 Agent 配置沉淀为可复用的会话入口</span></div></div>
      <div className="agent-center-actions"><button className="secondary-button" onClick={() => setTransferOpen(true)} type="button"><Copy size={14} />导入 / 导出</button><button className="primary-button" onClick={openCreateAgent} type="button"><Plus size={15} />新建 Agent</button></div>
    </header>
    <div className="agent-center-grid">
      <aside className="agent-list-panel">
        <div className="agent-list-heading"><div><strong>我的 Agent</strong><small>{agents.length} 个配置</small></div><button className="icon-button" onClick={() => notify('已打开排序设置')} title="排序设置" type="button"><Settings2 size={15} /></button></div>
        <label className="agent-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Agent" /></label>
        <div className="agent-type-filter">{([{ label: '全部', value: 'all' }, { label: 'Claude', value: 'claude' }, { label: 'Codex', value: 'codex' }, { label: 'GUI', value: 'gui' }] as const).map((item) => <button className={type === item.value ? 'active' : ''} key={item.value} onClick={() => setType(item.value)} type="button">{item.label}</button>)}</div>
        <div className="agent-list-scroll">{filtered.map((agent) => <div className={`agent-list-item-wrap ${selected.id === agent.id ? 'active' : ''}`} key={agent.id}><button className="agent-list-item" onClick={() => { setSelectedId(agent.id); setTab('summary'); setMenuAgentId(null); }} type="button"><span className="agent-avatar" style={{ background: agent.color }}><Bot size={16} /></span><span className="agent-list-copy"><strong>{agent.name}</strong><small>{agentTypeLabel(agent.type)} · {agent.model}</small><em>{agent.sessions} 个会话 · {agent.updated}</em></span></button><button aria-label={`${agent.name} 更多操作`} className="agent-list-more icon-button" onClick={() => setMenuAgentId(menuAgentId === agent.id ? null : agent.id)} title="更多操作" type="button"><MoreHorizontal size={15} /></button>{menuAgentId === agent.id && <div className="agent-list-menu" role="menu"><button onClick={() => openEditAgent(agent)} role="menuitem" type="button">编辑配置</button><button onClick={() => openCopyAgent(agent)} role="menuitem" type="button">复制配置</button><button onClick={() => openDeleteAgent(agent)} role="menuitem" type="button">删除 Agent</button></div>}</div>)}{filtered.length === 0 && <p className="agent-empty">没有匹配的 Agent</p>}</div>
        <button className="agent-template-button" onClick={openTemplateAgent} type="button"><Sparkles size={15} />从模板创建</button>
      </aside>
      <main className="agent-detail-panel">
        {editorOpen ? (
          <AgentEditorPage value={newAgentDraft} mode="new" onCancel={() => { setEditorOpen(false); setNewAgentDraft(null); }} onSave={saveNewAgent} />
        ) : editingSelected && selectedDraft ? (
          <AgentDetailEditor value={selectedDraft} onCancel={() => cancelEditing(selected.id)} onChange={(next) => setDraftsById((current) => ({ ...current, [selected.id]: next }))} onSave={saveEditedAgent} />
        ) : (
          <>
            <div className="agent-detail-top"><div className="agent-detail-heading"><span className="agent-avatar large" style={{ background: selected.color }}><Bot size={22} /></span><div><h1>{selected.name}</h1><p>{selected.description}</p><div className="agent-pills"><span className="agent-pill blue">{agentTypeLabel(selected.type)}</span><span className="agent-pill">{selected.model}</span><span className="agent-pill green"><Check size={12} />已启用</span></div></div></div><div className="agent-detail-actions"><button className="secondary-button" onClick={() => openEditAgent(selected)} type="button"><Settings2 size={14} />编辑配置</button><button className="secondary-button" onClick={() => openCopyAgent(selected)} type="button"><Copy size={14} />复制配置</button></div></div>
            <nav className="agent-tabs" aria-label="Agent 配置页签"><button className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')} type="button">配置总览</button><button className={tab === 'basic' ? 'active' : ''} onClick={() => setTab('basic')} type="button">基本信息</button><button className={tab === 'behavior' ? 'active' : ''} onClick={() => setTab('behavior')} type="button">行为规则</button><button className={tab === 'capabilities' ? 'active' : ''} onClick={() => setTab('capabilities')} type="button">能力与资源</button></nav>
            {tab === 'summary' && <div className="agent-overview"><AgentBasicSection agent={selected} onEdit={() => openEditAgent(selected)} /><AgentBehaviorSection agent={selected} onEdit={() => openEditAgent(selected)} />{selectedReviewDemo && <CodeReviewDemoSection demo={selectedReviewDemo} />}<CapabilitySection title="关联 Skill" items={selected.skillNames ?? selected.capabilities} empty="未配置 Skill" /><CapabilitySection title="知识库与文档资源" items={selected.knowledgeBases ?? [selected.cwd]} empty="未配置文档目录或链接" /><CapabilitySection title="MCP 服务" items={selected.mcps ?? []} empty="未配置 MCP" /></div>}
            {tab === 'basic' && <div className="agent-overview"><AgentBasicSection agent={selected} onEdit={() => openEditAgent(selected)} /></div>}
            {tab === 'behavior' && <div className="agent-overview"><AgentBehaviorSection agent={selected} onEdit={() => openEditAgent(selected)} /></div>}
            {tab === 'capabilities' && <div className="agent-overview"><CapabilitySection title="关联 Skill" items={selected.skillNames ?? selected.capabilities} empty="未配置 Skill" /><CapabilitySection title="知识库与文档资源" items={selected.knowledgeBases ?? [selected.cwd]} empty="未配置文档目录或链接" /><CapabilitySection title="MCP 服务" items={selected.mcps ?? []} empty="未配置 MCP" /></div>}
          </>
        )}
      </main>
      <aside className="agent-summary-panel">
        <div className="agent-summary-heading"><div><strong>运行摘要</strong><small>{workspaceLoaded ? '基于当前会话数据' : '正在加载会话数据'}</small></div><button className="icon-button" onClick={() => notify('已打开更多设置')} title="更多设置" type="button"><MoreHorizontal size={16} /></button></div>
        <button className="create-agent-session" onClick={() => onCreateSession ? onCreateSession(selected) : setSessionDemoOpen(true)} type="button"><MessageSquare size={16} /><span><strong>新建 Agent 会话</strong><small>进入配置化会话交互</small></span><Plus size={16} /></button>
        <button className="agent-preview-session-button" onClick={() => setSessionDemoOpen(true)} type="button"><TerminalSquare size={15} />预览 Agent 会话形态</button>
        <SummaryMetric label="已创建会话" value={workspaceLoaded ? selectedSummary.sessionCount : '加载中'} />
        <SummaryMetric label="关联 Skill" value={selectedSkillCount} />
        <section className="agent-summary-section"><h3>最近会话</h3>{!workspaceLoaded ? <p className="agent-empty">正在加载真实会话数据…</p> : selectedSummary.recentSessions.length ? selectedSummary.recentSessions.map((item) => <RecentSession color={item.color} detail={item.detail} key={item.id} title={item.title} />) : <p className="agent-empty">暂无该 Agent 相关会话</p>}</section>
        <section className="agent-summary-section"><h3>配置提示</h3><p className="agent-summary-note">Agent 配置会随会话保存，创建后左侧展示配置，右侧负责实际交互。</p></section>
      </aside>
    </div>{message && <div className="agent-demo-toast">{message}</div>}
    {transferOpen && <AgentCenterTransferDialog agents={agents} onApplyImport={(nextAgents) => { setAgents(nextAgents); }} onClose={() => setTransferOpen(false)} onMessage={notify} />}
    {deletingAgent && <DeleteAgentDialog agent={deletingAgent} relatedSessionCount={deletingAgentSessionCount} onCancel={() => setDeletingAgent(null)} onConfirm={() => void removeAgent(deletingAgent)} />}
  </section>;
}

function loadAgents(): AgentDefinition[] {
  try {
    const raw = window.localStorage.getItem(AGENT_STORAGE_KEY);
    if (!raw) return AGENTS;
    const parsed = JSON.parse(raw) as AgentDefinition[];
    return Array.isArray(parsed) && parsed.length > 0 ? mergeBuiltInAgents(parsed) : AGENTS;
  } catch {
    return AGENTS;
  }
}

function cloneAgent(agent: AgentDefinition): AgentDefinition {
  return {
    ...agent,
    capabilities: [...agent.capabilities],
    behaviorRules: agent.behaviorRules ? [...agent.behaviorRules] : undefined,
    skillNames: agent.skillNames ? [...agent.skillNames] : undefined,
    knowledgeBases: agent.knowledgeBases ? [...agent.knowledgeBases] : undefined,
    mcps: agent.mcps ? [...agent.mcps] : undefined,
    reviewDemo: agent.reviewDemo ? {
      inputs: agent.reviewDemo.inputs.map((input) => ({ ...input })),
      dimensions: [...agent.reviewDemo.dimensions],
      outputs: agent.reviewDemo.outputs.map((output) => ({ ...output })),
    } : undefined,
  };
}

function mergeBuiltInAgents(storedAgents: AgentDefinition[]) {
  const storedById = new Map(storedAgents.map((agent) => [agent.id, agent]));
  const ordered = AGENTS.map((builtIn) => {
    const stored = storedById.get(builtIn.id);
    if (!stored) return builtIn;
    if (shouldUpgradeBuiltInAgent(stored, builtIn)) return builtIn;
    return {
      ...builtIn,
      ...stored,
      capabilities: stored.capabilities ?? builtIn.capabilities,
      behaviorRules: stored.behaviorRules ?? builtIn.behaviorRules,
      skillNames: stored.skillNames ?? builtIn.skillNames,
      knowledgeBases: stored.knowledgeBases ?? builtIn.knowledgeBases,
      mcps: stored.mcps ?? builtIn.mcps,
      reviewDemo: builtIn.id === 'review' ? builtIn.reviewDemo : stored.reviewDemo ?? builtIn.reviewDemo,
    };
  });
  const builtInIds = new Set(AGENTS.map((agent) => agent.id));
  const customAgents = storedAgents.filter((agent) => !builtInIds.has(agent.id));
  return [...ordered, ...customAgents];
}

function shouldUpgradeBuiltInAgent(stored: AgentDefinition, builtIn: AgentDefinition) {
  if (builtIn.id !== 'review') return false;
  return !stored.reviewDemo
    || !Array.isArray(stored.reviewDemo.outputs)
    || !Array.isArray(stored.reviewDemo.inputs)
    || stored.reviewDemo.outputs.length !== builtIn.reviewDemo?.outputs.length
    || stored.reviewDemo.inputs.length !== builtIn.reviewDemo?.inputs.length
    || stored.name === '代码审查 Agent'
    || stored.prompt === '你是一名严格但务实的代码审查工程师。优先报告真实 bug、回归风险和测试缺口。';
}

function parseListInput(value: string) {
  return value.split(/\n|,/).map((item) => item.trim());
}

function cleanList(items?: string[]) {
  return items?.map((item) => item.trim()).filter(Boolean) ?? [];
}

function formatWorkingDirectoryError(error: unknown): string {
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return '工作目录校验失败，请检查路径是否存在且为目录';
}

function WorkingDirectoryField({
  value,
  error,
  onChange,
  onPick,
  onReveal,
  onClear,
}: {
  value: string;
  error: string | null;
  onChange: (value: string) => void;
  onPick: () => void | Promise<void>;
  onReveal: () => void | Promise<void>;
  onClear: () => void;
}) {
  return (
    <label>
      工作目录
      <div className="agent-editor-field-row">
        <input aria-describedby={error ? 'working-directory-error' : undefined} aria-label="工作目录" value={value} onChange={(event) => onChange(event.target.value)} />
        <button className="secondary-button" onClick={() => void onPick()} type="button">选择文件夹</button>
        <button aria-label="在 Finder 中打开" className="icon-button" disabled={!value.trim()} onClick={() => void onReveal()} title="在 Finder 中打开" type="button"><FolderOpen size={15} /></button>
        <button aria-label="清空工作目录" className="icon-button" disabled={!value} onClick={onClear} title="清空工作目录" type="button"><X size={15} /></button>
      </div>
      {error && <span className="agent-field-error" id="working-directory-error" role="alert">{error}</span>}
    </label>
  );
}

function DeleteAgentDialog({
  agent,
  relatedSessionCount,
  onCancel,
  onConfirm,
}: {
  agent: AgentDefinition;
  relatedSessionCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section aria-labelledby="delete-agent-title" aria-modal="true" className="session-dialog" role="dialog">
        <h2 id="delete-agent-title">删除 Agent</h2>
        <p>确认删除“{agent.name}”吗？</p>
        <p className="agent-delete-impact">该 Agent 关联 {relatedSessionCount} 个历史会话</p>
        <p>删除 Agent 配置不会删除历史会话和会话内容。</p>
        <p>删除后配置本身无法恢复。</p>
        <footer>
          <button onClick={onCancel} type="button">取消删除</button>
          <button className="danger-button" onClick={onConfirm} type="button">确认删除</button>
        </footer>
      </section>
    </div>
  );
}

function AgentBasicSection({ agent, onEdit }: { agent: AgentDefinition; onEdit: () => void }) {
  return <section className="agent-config-section"><SectionTitle title="基本信息" action="编辑" onClick={onEdit} /><div className="agent-detail-intro"><small>Agent 名称</small><strong>{agent.name}</strong><p>{agent.description}</p></div><div className="agent-info-grid"><InfoBlock icon={<TerminalSquare size={15} />} label="运行类型" value={`${agentTypeLabel(agent.type)} 会话`} /><InfoBlock icon={<Sparkles size={15} />} label="默认模型" value={agent.model} /><InfoBlock icon={<FolderOpen size={15} />} label="工作目录" value={agent.cwd} /><InfoBlock icon={<GitBranch size={15} />} label="默认分组" value={agent.group} /></div></section>;
}

function AgentBehaviorSection({ agent, onEdit }: { agent: AgentDefinition; onEdit: () => void }) {
  const rules = agent.behaviorRules?.length ? agent.behaviorRules : [];
  return <><section className="agent-config-section"><SectionTitle title="行为规则" action="编辑" onClick={onEdit} />{rules.length > 0 ? <div className="agent-behavior-rule-list">{rules.map((rule) => <div className="agent-rule-row" key={rule}><Check size={15} />{rule}</div>)}</div> : <p className="agent-empty">未配置行为规则</p>}</section><section className="agent-config-section"><SectionTitle title="系统提示词" action="编辑" onClick={onEdit} /><div className="agent-prompt">{agent.prompt || '未配置系统提示词'}</div></section></>;
}

function AgentEditorPage({ value, mode, onCancel, onSave }: { value: AgentDefinition | null; mode: 'new'; onCancel: () => void; onSave: (agent: AgentDefinition) => void }) {
  const [draft, setDraft] = useState<AgentDefinition>(() => value ?? {
    id: `agent-${Date.now()}`, name: '', description: '', type: 'claude', model: 'Claude Sonnet 4.6', skills: 0, sessions: 0,
    updated: '刚刚', color: '#3f82d8', cwd: '/tmp/agentbox-project', group: '未分组', prompt: '', behaviorRules: [], capabilities: [], skillNames: [], knowledgeBases: [], mcps: [],
  });
  const [workingDirectoryError, setWorkingDirectoryError] = useState<string | null>(null);
  const update = (changes: Partial<AgentDefinition>) => {
    setDraft((current) => ({ ...current, ...changes }));
    if (changes.cwd !== undefined) {
      setWorkingDirectoryError(null);
    }
  };
  const modelOptions = MODEL_OPTIONS[draft.type];
  const listValue = (items?: string[]) => (items ?? []).join('\n');
  const pickWorkingDirectory = async () => {
    try {
      const selected = await chooseWorkingDirectory();
      if (selected) {
        update({ cwd: selected });
      }
    } catch (error) {
      setWorkingDirectoryError(formatWorkingDirectoryError(error));
    }
  };
  const revealWorkingDirectory = async () => {
    const cwd = draft.cwd.trim();
    if (!cwd) {
      setWorkingDirectoryError('工作目录不能为空');
      return;
    }
    try {
      await validateWorkingDirectory(cwd);
      await openWorkingDirectory(cwd);
    } catch (error) {
      setWorkingDirectoryError(formatWorkingDirectoryError(error));
    }
  };
  const saveDraft = async () => {
    const cwd = draft.cwd.trim();
    if (!cwd) {
      setWorkingDirectoryError('工作目录不能为空');
      return;
    }
    try {
      await validateWorkingDirectory(cwd);
    } catch (error) {
      setWorkingDirectoryError(formatWorkingDirectoryError(error));
      return;
    }
    onSave({ ...draft, cwd, name: draft.name.trim(), description: draft.description.trim(), prompt: draft.prompt.trim(), behaviorRules: cleanList(draft.behaviorRules), skillNames: cleanList(draft.skillNames), knowledgeBases: cleanList(draft.knowledgeBases), mcps: cleanList(draft.mcps), skills: cleanList(draft.skillNames).length, updated: '刚刚' });
  };
  return <section className="agent-center-editor-page"><header className="agent-editor-page-header"><div><button className="icon-button" aria-label="返回 Agent 中心" onClick={onCancel} title="返回" type="button"><X size={17} /></button><div><h2>{mode === 'new' ? '新建 Agent' : '编辑 Agent'}</h2><span>配置会应用于之后新建的会话，不影响正在运行的会话</span></div></div><div><button onClick={onCancel} type="button">取消</button><button className="primary-button" disabled={!draft.name.trim() || !draft.description.trim() || !draft.prompt.trim()} onClick={() => void saveDraft()} type="button">保存配置</button></div></header><form className="agent-editor-page-form" onSubmit={(event) => event.preventDefault()}><div className="agent-editor-page-main"><section><h2>基本信息</h2><label>Agent 名称<input autoFocus value={draft.name} onChange={(event) => update({ name: event.target.value })} placeholder="例如：服务瘦身助手" /></label><label>简介<textarea value={draft.description} onChange={(event) => update({ description: event.target.value })} placeholder="说明这个 Agent 适合处理什么问题" /></label><div className="agent-editor-row"><label>运行类型<select value={draft.type} onChange={(event) => { const next = event.target.value as AgentCenterType; update({ type: next, model: MODEL_OPTIONS[next][0] }); }}><option value="claude">Claude</option><option value="codex">Codex</option><option value="gui">GUI</option></select></label><label>模型<select value={draft.model} onChange={(event) => update({ model: event.target.value })}>{modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}</select></label></div><WorkingDirectoryField value={draft.cwd} error={workingDirectoryError} onChange={(cwd) => update({ cwd })} onPick={pickWorkingDirectory} onReveal={revealWorkingDirectory} onClear={() => update({ cwd: '' })} /><label>默认分组<input value={draft.group} onChange={(event) => update({ group: event.target.value })} /></label></section><section><h2>行为规则</h2><label>行为规则<textarea className="agent-prompt-editor" value={listValue(draft.behaviorRules)} onChange={(event) => update({ behaviorRules: parseListInput(event.target.value) })} placeholder="每行一条行为规则，例如：先给结论，再展开分析" /></label></section><section><h2>系统提示词</h2><label>系统提示词<textarea className="agent-prompt-editor" value={draft.prompt} onChange={(event) => update({ prompt: event.target.value })} placeholder="描述 Agent 的角色、工作方式和输出要求" /></label></section><section><h2>能力与资源</h2><AgentSkillField selected={draft.skillNames ?? []} cwd={draft.cwd} onChange={(skills) => update({ skillNames: skills, skills: skills.length })} /><label>知识库 / 文档目录 / 文档链接<textarea value={listValue(draft.knowledgeBases)} onChange={(event) => update({ knowledgeBases: parseListInput(event.target.value) })} placeholder="每行一个本地目录、文件或文档链接" /></label><label>MCP 服务<textarea value={listValue(draft.mcps)} onChange={(event) => update({ mcps: parseListInput(event.target.value) })} placeholder="每行一个 MCP 服务名称或配置标识" /></label><p className="agent-editor-hint">资源只记录配置，不会在保存时自动读取或执行。</p></section></div></form></section>;
}

function AgentDetailEditor({
  value,
  onCancel,
  onChange,
  onSave,
}: {
  value: AgentDefinition;
  onCancel: () => void;
  onChange: (agent: AgentDefinition) => void;
  onSave: (agent: AgentDefinition) => void;
}) {
  const [workingDirectoryError, setWorkingDirectoryError] = useState<string | null>(null);
  const update = (changes: Partial<AgentDefinition>) => onChange({ ...value, ...changes });
  const listValue = (items?: string[]) => (items ?? []).join('\n');
  const pickWorkingDirectory = async () => {
    try {
      const selected = await chooseWorkingDirectory();
      if (selected) {
        update({ cwd: selected });
        setWorkingDirectoryError(null);
      }
    } catch (error) {
      setWorkingDirectoryError(formatWorkingDirectoryError(error));
    }
  };
  const revealWorkingDirectory = async () => {
    const cwd = value.cwd.trim();
    if (!cwd) {
      setWorkingDirectoryError('工作目录不能为空');
      return;
    }
    try {
      await validateWorkingDirectory(cwd);
      await openWorkingDirectory(cwd);
    } catch (error) {
      setWorkingDirectoryError(formatWorkingDirectoryError(error));
    }
  };
  const saveDraft = async () => {
    const cwd = value.cwd.trim();
    if (!cwd) {
      setWorkingDirectoryError('工作目录不能为空');
      return;
    }
    try {
      await validateWorkingDirectory(cwd);
    } catch (error) {
      setWorkingDirectoryError(formatWorkingDirectoryError(error));
      return;
    }
    onSave({ ...value, cwd, name: value.name.trim(), description: value.description.trim(), prompt: value.prompt.trim(), behaviorRules: cleanList(value.behaviorRules), skillNames: cleanList(value.skillNames), knowledgeBases: cleanList(value.knowledgeBases), mcps: cleanList(value.mcps), skills: cleanList(value.skillNames).length, updated: '刚刚' });
  };
  const selectedSkills = value.skillNames ?? value.capabilities;
  return (
    <div className="agent-detail-editor">
      <header>
        <div>
          <h2>编辑 Agent</h2>
          <p>修改后仅影响新建的 Agent 会话</p>
        </div>
        <div>
          <button onClick={onCancel} type="button">取消</button>
          <button
            className="primary-button"
            disabled={!value.name.trim() || !value.description.trim() || !value.prompt.trim()}
            onClick={() => void saveDraft()}
            type="button"
          >
            保存
          </button>
        </div>
      </header>
      <div className="agent-detail-editor-grid">
        <section>
          <h3>基本信息</h3>
          <label>名称<input autoFocus value={value.name} onChange={(event) => update({ name: event.target.value })} /></label>
          <label>简介<textarea value={value.description} onChange={(event) => update({ description: event.target.value })} /></label>
          <div className="agent-editor-row">
            <label>Agent 类型<select value={value.type} onChange={(event) => { const type = event.target.value as AgentCenterType; update({ type, model: MODEL_OPTIONS[type][0] }); }}><option value="claude">Claude</option><option value="codex">Codex</option><option value="gui">GUI</option></select></label>
            <label>模型<select value={value.model} onChange={(event) => update({ model: event.target.value })}>{MODEL_OPTIONS[value.type].map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
          </div>
          <WorkingDirectoryField value={value.cwd} error={workingDirectoryError} onChange={(cwd) => { update({ cwd }); setWorkingDirectoryError(null); }} onPick={pickWorkingDirectory} onReveal={revealWorkingDirectory} onClear={() => { update({ cwd: '' }); setWorkingDirectoryError(null); }} />
          <label>默认分组<input value={value.group} onChange={(event) => update({ group: event.target.value })} /></label>
        </section>
        <section>
          <h3>行为规则</h3>
          <label>行为规则<textarea className="agent-prompt-editor" value={listValue(value.behaviorRules)} onChange={(event) => update({ behaviorRules: parseListInput(event.target.value) })} placeholder="每行一条行为规则，例如：先给结论，再展开分析" /></label>
        </section>
        <section>
          <h3>系统提示词</h3>
          <label>系统提示词<textarea className="agent-prompt-editor" value={value.prompt} onChange={(event) => update({ prompt: event.target.value })} /></label>
        </section>
        <section>
          <h3>能力与资源</h3>
          <AgentSkillField selected={selectedSkills} cwd={value.cwd} onChange={(skills) => update({ skillNames: skills, skills: skills.length })} />
          <label>知识库 / 文档目录 / 链接<textarea value={listValue(value.knowledgeBases)} onChange={(event) => update({ knowledgeBases: parseListInput(event.target.value) })} placeholder="每行一个本地目录、文件或链接" /></label>
          <label>MCP 服务<textarea value={listValue(value.mcps)} onChange={(event) => update({ mcps: parseListInput(event.target.value) })} placeholder="每行一个 MCP 服务" /></label>
        </section>
      </div>
    </div>
  );
}

function AgentSkillField({ selected, cwd, onChange }: { selected: string[]; cwd: string; onChange: (skills: string[]) => void }) {
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  return (
    <>
      <div className="agent-editor-field-header">
        <label>Skill</label>
        <button className="secondary-button" onClick={() => setSkillPickerOpen(true)} type="button"><Plus size={14} />添加 Skill</button>
      </div>
      <div className="agent-selected-chips">
        {selected.map((skill) => <span key={skill}>{skill}<button aria-label={`移除 ${skill}`} onClick={() => onChange(selected.filter((item) => item !== skill))} type="button">×</button></span>)}
      </div>
      {skillPickerOpen && <SkillPicker selected={selected} cwd={cwd} onCancel={() => setSkillPickerOpen(false)} onConfirm={(skills) => { onChange(skills); setSkillPickerOpen(false); }} />}
    </>
  );
}

function SkillPicker({ selected, cwd, onCancel, onConfirm }: { selected: string[]; cwd: string; onCancel: () => void; onConfirm: (skills: string[]) => void }) {
  const [items, setItems] = useState<AgentSkillItem[]>([]);
  const [checked, setChecked] = useState(() => new Set(selected));
  const [query, setQuery] = useState('');
  useEffect(() => { void listAgentSkills(cwd).then(setItems).catch(() => setItems([])); }, [cwd]);
  const filtered = items.filter((item) => `${item.name} ${item.description} ${item.command}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="agent-skill-picker"><header><div><h3>添加 Skill</h3><p>选择本机已安装、当前 Agent 可使用的 Skill</p></div><button className="icon-button" onClick={onCancel} type="button"><X size={17} /></button></header><div className="agent-skill-filters"><input aria-label="搜索 Skill" onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Skill 名称或描述" value={query} /><span>已选 {checked.size} 项</span></div><div className="agent-skill-picker-list">{filtered.map((item) => <button className={checked.has(item.name) ? 'selected' : ''} key={`${item.agent}-${item.path}`} onClick={() => setChecked((current) => { const next = new Set(current); if (next.has(item.name)) next.delete(item.name); else next.add(item.name); return next; })} type="button"><span className="skill-check">{checked.has(item.name) ? '✓' : ''}</span><span><strong>{item.name}</strong><small>{item.command} · {item.source}</small><em>{item.description}</em></span></button>)}{filtered.length === 0 && <p className="agent-empty">没有读取到匹配 Skill。请确认 Skill 已安装，或检查工作目录。</p>}</div><footer><button onClick={onCancel} type="button">取消</button><button className="primary-button" onClick={() => onConfirm([...checked])} type="button">确认（{checked.size}）</button></footer></div>;
}

function CodeReviewDemoSection({ demo }: { demo: CodeReviewDemoConfig }) {
  const [activeOutput, setActiveOutput] = useState<'all' | 'confirmed' | 'risk'>('all');
  const visibleOutputs = demo.outputs.filter((output) => activeOutput === 'all' || output.kind === activeOutput);
  return (
    <section className="agent-config-section agent-review-demo" aria-label="Code Review Demo">
      <SectionTitle title="Code Review Demo" action="示例配置" onClick={() => undefined} />
      <p className="agent-review-intro">下面是该 Agent 期望接收的输入和输出形态。正式会话中，Agent 会根据实际 Git diff 和项目上下文生成结果。</p>
      <div className="agent-review-layout">
        <div className="agent-review-column">
          <div className="agent-review-subtitle"><FileCode2 size={14} />审查输入</div>
          <div className="agent-review-inputs">
            {demo.inputs.map((input, index) => (
              <div className="agent-review-input-card" key={input.title}>
                <span>{index + 1}</span>
                <div><strong>{input.title}</strong><p>{input.description}</p></div>
              </div>
            ))}
          </div>
          <div className="agent-review-subtitle"><Check size={14} />检查维度</div>
          <div className="agent-review-dimensions">
            {demo.dimensions.map((dimension) => <span key={dimension}>{dimension}</span>)}
          </div>
        </div>
        <div className="agent-review-column">
          <div className="agent-review-result-heading">
            <div className="agent-review-subtitle"><GitBranch size={14} />Review 输出示例</div>
            <span className="agent-review-count">{visibleOutputs.length} 条</span>
          </div>
          <div className="agent-review-filters" role="tablist" aria-label="Review 结果筛选">
            <button className={activeOutput === 'all' ? 'active' : ''} onClick={() => setActiveOutput('all')} type="button">全部</button>
            <button className={activeOutput === 'confirmed' ? 'active' : ''} onClick={() => setActiveOutput('confirmed')} type="button">确定问题</button>
            <button className={activeOutput === 'risk' ? 'active' : ''} onClick={() => setActiveOutput('risk')} type="button">人工确认风险</button>
          </div>
          <div className="agent-review-output-list">
            {visibleOutputs.map((output) => <ReviewOutputCard key={`${output.file}-${output.line}`} output={output} />)}
          </div>
        </div>
      </div>
    </section>
  );
}

function ReviewOutputCard({ output }: { output: CodeReviewDemoConfig['outputs'][number] }) {
  const confirmed = output.kind === 'confirmed';
  return (
    <article className={`agent-review-output-card ${confirmed ? 'confirmed' : 'risk'}`}>
      <div className="agent-review-output-topline">
        <span className="agent-review-kind">{confirmed ? '确定问题' : '人工确认风险'}</span>
        <span className={`agent-review-severity ${output.severity === '严重' ? 'high' : output.severity === '中等' ? 'medium' : 'low'}`}>{output.severity}</span>
      </div>
      <h4>{output.title}</h4>
      <code>{output.file} · {output.line}</code>
      <dl>
        <div><dt>原因</dt><dd>{output.reason}</dd></div>
        <div><dt>复现方式</dt><dd>{output.reproduce}</dd></div>
        <div><dt>修改建议</dt><dd>{output.suggestion}</dd></div>
      </dl>
    </article>
  );
}

const MODEL_OPTIONS: Record<AgentCenterType, string[]> = {
  claude: ['Claude Sonnet 4.6', 'Claude Opus 4.6', 'Claude Haiku 4.5'],
  codex: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2'],
  gui: ['Claude Sonnet 4.6', 'Claude Opus 4.6', 'gpt-5.5', 'gpt-5.2'],
};

function CapabilitySection({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return <section className="agent-config-section"><SectionTitle title={title} action={`${items.length} 项`} onClick={() => undefined} />{items.length > 0 ? <div className="agent-capability-list">{items.map((item) => <div key={item}><span className="capability-icon"><Sparkles size={14} /></span><span><strong>{item}</strong><small>Agent 配置资源</small></span><Check size={15} /></div>)}</div> : <p className="agent-empty">{empty}</p>}</section>;
}

function InfoBlock({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) { return <div className="agent-info-block"><span>{icon}</span><small>{label}</small><strong title={value}>{value}</strong></div>; }
function SectionTitle({ title, action, onClick }: { title: string; action: string; onClick: () => void }) { return <header className="agent-section-title"><h2>{title}</h2><button onClick={onClick} type="button">{action}<ChevronDown size={13} /></button></header>; }
function SummaryMetric({ label, value }: { label: string; value: number | string }) { return <div className="agent-metric"><span>{label}</span><strong>{value}</strong></div>; }
function RecentSession({ title, detail, color }: { title: string; detail: string; color: string }) { return <button className="recent-session" type="button"><span className="recent-dot" style={{ background: color }} /><span><strong>{title}</strong><small>{detail}</small></span><ChevronDown size={14} /></button>; }

export type AgentSessionPreset = {
  name: string;
  agent: SessionAgentType;
  model?: string;
  cwd: string;
  guiAgent?: GuiAgentType;
  guiModel?: GuiModelType;
  agentConfig?: AgentSessionConfig;
};

function agentTypeLabel(type: AgentCenterType) {
  return type === 'claude' ? 'Claude' : type === 'codex' ? 'Codex' : 'GUI';
}

function buildAgentSummary(agent: AgentDefinition, archive: AiWorkspaceArchive | null) {
  const sessions = archive?.sessions ?? [];
  const recentSessions = sessions
    .filter((session) => matchesAgentSession(session, agent))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3)
    .map((session) => ({
      id: session.id,
      title: session.name,
      detail: `${formatAgentSessionTime(session.updatedAt)} · ${agentSessionStatusLabel(session.status)}`,
      color: agent.color,
    }));
  return {
    sessionCount: sessions.filter((session) => matchesAgentSession(session, agent)).length,
    recentSessions,
  };
}

function matchesAgentSession(session: AiWorkspaceArchive['sessions'][number], agent: AgentDefinition) {
  const config = session.agentConfig;
  return config?.agentId === agent.id || config?.agentName === agent.name || session.name === agent.name;
}

function formatAgentSessionTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

function agentSessionStatusLabel(status: AiWorkspaceArchive['sessions'][number]['status']) {
  if (status === 'starting') return '启动中';
  if (status === 'running') return '进行中';
  if (status === 'stopping') return '停止中';
  if (status === 'error') return '异常';
  return '已完成';
}
