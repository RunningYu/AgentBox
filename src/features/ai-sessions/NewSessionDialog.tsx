import { FolderOpen, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AgentSessionConfig, AgentType, AiSessionGroup, GuiAgentType, GuiModelType } from '../../shared/types';
import { defaultGuiModel, parseResumeSessionInput } from './sessionModel';
import { chooseWorkingDirectory, validateWorkingDirectory } from './terminalApi';
import { GUI_MODEL_OPTIONS } from './guiModels';

export interface NewSessionInput {
  name: string;
  agent: AgentType;
  model?: string;
  guiAgent?: GuiAgentType;
  guiModel?: GuiModelType;
  cwd: string;
  groupId: string | null;
  cliSessionId?: string;
  resumeExisting?: boolean;
  agentConfig?: AgentSessionConfig;
}

interface NewSessionDialogProps {
  groups: AiSessionGroup[];
  initialCwd?: string;
  initialGroupId: string | null;
  initialName?: string;
  initialAgent?: AgentType;
  initialModel?: string;
  initialGuiAgent?: GuiAgentType;
  initialGuiModel?: GuiModelType;
  initialAgentConfig?: AgentSessionConfig;
  onCancel: () => void;
  onCreate: (input: NewSessionInput) => Promise<boolean | void>;
  onError: (message: string) => void;
}

export function NewSessionDialog({ groups, initialCwd = '', initialGroupId, initialName, initialAgent = 'claude', initialModel, initialGuiAgent = 'claude', initialGuiModel, initialAgentConfig, onCancel, onCreate, onError }: NewSessionDialogProps) {
  const [agent, setAgent] = useState<AgentType>(initialAgent);
  const [model, setModel] = useState(initialModel ?? initialAgentConfig?.model ?? '');
  const [guiAgent, setGuiAgent] = useState<GuiAgentType>(initialGuiAgent);
  const [guiModel, setGuiModel] = useState<GuiModelType>(initialGuiModel ?? defaultGuiModel(initialGuiAgent));
  const [mode, setMode] = useState<'new' | 'resume'>('new');
  const [name, setName] = useState(initialName ?? agentLabel(initialAgent));
  const [cwd, setCwd] = useState(initialCwd);
  const [groupId, setGroupId] = useState<string | null>(initialGroupId);
  const [resumeCommand, setResumeCommand] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [workingDirectoryError, setWorkingDirectoryError] = useState<string | null>(null);

  function selectAgent(next: AgentType) {
    setAgent(next);
    if (next !== initialAgent) {
      setModel('');
    }
    if (next === 'terminal' || next === 'gui') {
      setMode('new');
    }
    if (name === 'Claude Code 会话' || name === 'Codex 会话' || name === '终端' || name === 'GUI 会话') {
      setName(agentLabel(next));
    }
  }

  async function selectDirectory() {
    try {
      const selected = await chooseWorkingDirectory();
      if (selected) {
        setCwd(selected);
        setWorkingDirectoryError(null);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !cwd.trim()) {
      onError('请填写会话名称和工作目录');
      return;
    }
    const parsedResume = mode === 'resume' ? parseResumeSessionInput(resumeCommand) : undefined;
    if (mode === 'resume' && !parsedResume) {
      onError('请填写有效的恢复命令或会话 ID');
      return;
    }
    setSubmitting(true);
    try {
      // 创建前先校验目录，避免无效目录进入会话列表后才在 PTY 启动阶段失败。
      try {
        await validateWorkingDirectory(cwd.trim());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const directoryError = message || '工作目录不存在或不是有效目录，请更换工作目录';
        setWorkingDirectoryError(directoryError);
        onError(directoryError);
        return;
      }

      const created = await onCreate({
        name: name.trim(),
        agent: parsedResume?.agent ?? agent,
        model: model.trim() || undefined,
        guiAgent: agent === 'gui' ? guiAgent : undefined,
        guiModel: agent === 'gui' ? guiModel : undefined,
        cwd: cwd.trim(),
        groupId,
        cliSessionId: parsedResume?.cliSessionId,
        resumeExisting: mode === 'resume',
        agentConfig: initialAgentConfig,
      });
      if (created === false) {
        setWorkingDirectoryError('工作目录不存在或不是有效目录，请更换工作目录');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="new-session-dialog" onSubmit={submit}>
        <header>
          <h2>新建 AI 会话</h2>
          <button aria-label="关闭" className="icon-button" onClick={onCancel} type="button">
            <X size={17} />
          </button>
        </header>

        <label>
          会话名称
          <input aria-label="会话名称" onChange={(event) => setName(event.target.value)} value={name} />
        </label>

        <fieldset>
          <legend>创建方式</legend>
          <div className="segmented">
            <button className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')} type="button">
              新建会话
            </button>
            <button className={mode === 'resume' ? 'active' : ''} disabled={agent === 'terminal' || agent === 'gui'} onClick={() => setMode('resume')} type="button">
              恢复已有会话
            </button>
          </div>
        </fieldset>

        <fieldset>
          <legend>会话类型</legend>
          <div className="segmented">
            <button
              className={agent === 'claude' ? 'active' : ''}
              onClick={() => selectAgent('claude')}
              type="button"
            >
              Claude Code
            </button>
            <button
              className={agent === 'codex' ? 'active' : ''}
              onClick={() => selectAgent('codex')}
              type="button"
            >
              Codex
            </button>
            <button
              className={agent === 'terminal' ? 'active' : ''}
              onClick={() => selectAgent('terminal')}
              type="button"
            >
              终端
            </button>
            <button
              className={agent === 'gui' ? 'active' : ''}
              onClick={() => selectAgent('gui')}
              type="button"
            >
              GUI
            </button>
          </div>
        </fieldset>

        {model && (
          <label>
            模型
            <input aria-label="模型" readOnly value={model} />
          </label>
        )}

        {agent === 'gui' && (
          <fieldset>
            <legend>GUI Agent</legend>
            <select
              aria-label="GUI Agent"
              onChange={(event) => {
                const nextAgent = event.target.value as GuiAgentType;
                setGuiAgent(nextAgent);
                setGuiModel(defaultGuiModel(nextAgent));
              }}
              value={guiAgent}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </fieldset>
        )}

        {agent === 'gui' && (
          <fieldset>
            <legend>GUI Model</legend>
            <select aria-label="GUI Model" onChange={(event) => setGuiModel(event.target.value)} value={guiModel}>
              {GUI_MODEL_OPTIONS[guiAgent].map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </fieldset>
        )}

        <label>
          所属分组
          <select
            aria-label="所属分组"
            onChange={(event) => setGroupId(event.target.value || null)}
            value={groupId ?? ''}
          >
            <option value="">未分组</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>{group.name}</option>
            ))}
          </select>
        </label>

        <label>
          工作目录
          <div className="directory-row">
            <input
              aria-label="工作目录"
              aria-describedby={workingDirectoryError ? 'new-session-working-directory-error' : undefined}
              onChange={(event) => {
                setCwd(event.target.value);
                setWorkingDirectoryError(null);
              }}
              placeholder="/path/to/project"
              value={cwd}
            />
            <button aria-label="选择工作目录" className="icon-button" onClick={selectDirectory} type="button">
              <FolderOpen size={17} />
            </button>
          </div>
          {workingDirectoryError && <span className="agent-field-error" id="new-session-working-directory-error" role="alert">{workingDirectoryError}</span>}
        </label>

        {mode === 'resume' && (
          <label>
            恢复命令或会话 ID
            <input
              aria-label="恢复命令或会话 ID"
              onChange={(event) => setResumeCommand(event.target.value)}
              placeholder="codex resume 019f... 或 claude --resume 256f..."
              value={resumeCommand}
            />
          </label>
        )}

        <footer>
          <button onClick={onCancel} type="button">取消</button>
          <button className="primary-button" disabled={submitting} type="submit">
            {submitting ? '正在启动' : mode === 'resume' ? '创建并恢复' : '创建并启动'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function agentLabel(agent: AgentType) {
  if (agent === 'claude') {
    return 'Claude Code 会话';
  }
  if (agent === 'codex') {
    return 'Codex 会话';
  }
  if (agent === 'gui') {
    return 'GUI 会话';
  }
  return '终端';
}
