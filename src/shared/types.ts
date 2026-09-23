export type FeatureType = 'prompt' | 'agent' | 'url' | 'snippet' | 'sequence';
export type AgentType = 'claude' | 'codex' | 'terminal' | 'gui';
export type GuiAgentType = 'claude' | 'codex';
export type GuiModelType = string;
export type SequenceRule = 'auto' | 'confirm';
export type SequenceTerminal = 'plain' | 'claude' | 'codex';

export interface AgentSessionConfig {
  agentId?: string;
  agentName?: string;
  model?: string;
  systemPrompt?: string;
  behaviorRules?: string[];
  skills?: string[];
  knowledgeBases?: string[];
  mcps?: string[];
}

export interface FeatureDef {
  id: string;
  name: string;
  description: string;
  script?: string | null;
  extra?: string | null;
  builtin: boolean;
  type?: string | null;
  agent?: string | null;
  autoRun?: boolean;
  seqRule?: string | null;
  seqTerm?: string | null;
}

export interface NormalizedFeatureDef extends FeatureDef {
  type: FeatureType;
  agent: AgentType;
  autoRun: boolean;
  seqRule: SequenceRule;
  seqTerm: SequenceTerminal;
}

export interface Prefs {
  favorites: string[];
  order: string[];
  globalShortcut?: string;
  quickPaletteSubmitMode?: 'insert' | 'insert-and-send';
}

export interface SessionEntry {
  agent: AgentType;
  sessionId: string;
  label?: string | null;
  timestamp: number;
}

export interface WorkflowProject {
  featureId: string;
  name: string;
  workDir?: string | null;
  timestamp: number;
  sessions: SessionEntry[];
}

export type AiSessionStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

export interface AiSessionGroup {
  id: string;
  name: string;
  createdAt: number;
  collapsed: boolean;
  pinned?: boolean;
  deletedAt?: number;
}

export interface AiSessionMetadata {
  id: string;
  name: string;
  agent: AgentType;
  cwd: string;
  status: AiSessionStatus;
  groupId: string | null;
  createdAt: number;
  updatedAt: number;
  cliSessionId?: string;
  model?: string;
  guiAgent?: GuiAgentType;
  guiModel?: GuiModelType;
  pinned: boolean;
  agentConfig?: AgentSessionConfig;
  // CLI Agent 配置只在首次任务前注入，后续回合沿用同一 CLI 上下文。
  agentConfigInitialized?: boolean;
}

export interface AiSessionRecord extends AiSessionMetadata {
  history: string;
  generation?: string;
  error?: string;
}

export interface ClaudeTranscriptMessage {
  kind: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

export interface FeatureWindowStepState {
  featureId: string;
  groupId: string | null;
  done: Record<number, boolean>;
  updatedAt: number;
}

export interface AiWorkspaceArchive {
  version: 2;
  groups: AiSessionGroup[];
  sessions: AiSessionMetadata[];
  featureWindowStates?: FeatureWindowStepState[];
}
