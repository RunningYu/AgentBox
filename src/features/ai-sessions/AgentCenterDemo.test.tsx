import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentCenterDemo } from './AgentCenterDemo';
import * as terminalApi from './terminalApi';
import * as promptpadStorage from '../../shared/promptpadStorage';
import type { AiWorkspaceArchive } from '../../shared/types';

vi.mock('./terminalApi', () => ({
  chooseWorkingDirectory: vi.fn(),
  listAgentSkills: vi.fn().mockResolvedValue([]),
  validateWorkingDirectory: vi.fn().mockResolvedValue(undefined),
  openWorkingDirectory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../shared/promptpadStorage', () => ({
  loadAiWorkspace: vi.fn(),
}));

function emptyArchive(): AiWorkspaceArchive {
  return {
    version: 2,
    groups: [],
    sessions: [],
  };
}

function session(overrides: Partial<AiWorkspaceArchive['sessions'][number]> = {}): AiWorkspaceArchive['sessions'][number] {
  return {
    id: overrides.id ?? 'session-1',
    name: overrides.name ?? '需求梳理会话',
    agent: overrides.agent ?? 'claude',
    cwd: overrides.cwd ?? '/tmp/agentbox-project',
    status: overrides.status ?? 'running',
    groupId: overrides.groupId ?? null,
    createdAt: overrides.createdAt ?? Date.now() - 3600000,
    updatedAt: overrides.updatedAt ?? Date.now() - 1800000,
    cliSessionId: overrides.cliSessionId,
    guiAgent: overrides.guiAgent,
    guiModel: overrides.guiModel,
    pinned: overrides.pinned ?? false,
    agentConfig: overrides.agentConfig,
  };
}

describe('AgentCenterDemo', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.mocked(terminalApi.chooseWorkingDirectory).mockResolvedValue(null);
    vi.mocked(terminalApi.validateWorkingDirectory).mockResolvedValue(undefined);
    vi.mocked(terminalApi.openWorkingDirectory).mockResolvedValue(undefined);
    vi.mocked(promptpadStorage.loadAiWorkspace).mockResolvedValue(emptyArchive());
  });

  it('returns to the AI workspace when the Agent center close button is clicked', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(<AgentCenterDemo onBack={onBack} />);

    await user.click(screen.getByTestId('agent-center-back'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('switches the visible detail page while preserving the open edit draft for the original agent', async () => {
    const user = userEvent.setup();
    render(<AgentCenterDemo onBack={vi.fn()} />);

    await user.click(screen.getByText('需求分析 Agent', { selector: 'strong' }).closest('button')!);
    await user.click(screen.getByRole('button', { name: '编辑配置' }));
    const nameInput = screen.getByLabelText('名称');
    await user.clear(nameInput);
    await user.type(nameInput, '需求分析 Agent（草稿）');

    await user.click(screen.getByText('Code Review Agent', { selector: 'strong' }).closest('button')!);
    expect(screen.getByRole('heading', { name: 'Code Review Agent' })).toBeVisible();
    expect(screen.queryByLabelText('名称')).not.toBeInTheDocument();

    await user.click(screen.getByText('需求分析 Agent', { selector: 'strong' }).closest('button')!);
    expect(screen.getByLabelText('名称')).toHaveValue('需求分析 Agent（草稿）');
  });

  it('shows real workspace summary data instead of static placeholders', async () => {
    vi.mocked(promptpadStorage.loadAiWorkspace).mockResolvedValue({
      ...emptyArchive(),
      sessions: [
        session({
          id: 'session-1',
          name: '需求分析会话-1',
          agentConfig: { agentId: 'requirement', agentName: '需求分析 Agent' },
          updatedAt: new Date('2026-09-08T10:35:00.000Z').getTime(),
          status: 'running',
        }),
        session({
          id: 'session-2',
          name: '代码审查会话-1',
          agentConfig: { agentId: 'review', agentName: '代码审查 Agent' },
          updatedAt: new Date('2026-09-08T09:10:00.000Z').getTime(),
          status: 'stopped',
        }),
      ],
    });

    render(<AgentCenterDemo onBack={vi.fn()} />);

    await userEvent.setup().click(screen.getByText('需求分析 Agent', { selector: 'strong' }).closest('button')!);
    expect(await screen.findByText('需求分析会话-1')).toBeInTheDocument();
    expect(screen.queryByText('退款规则梳理')).not.toBeInTheDocument();
    expect(await screen.findByText('基于当前会话数据')).toBeInTheDocument();
    expect(screen.getByText('运行摘要')).toBeInTheDocument();
  });

  it('opens a clean new-agent editor without reusing the selected agent header', async () => {
    const user = userEvent.setup();
    render(<AgentCenterDemo onBack={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '新建 Agent' }));
    expect(screen.getByRole('heading', { name: '新建 Agent' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Code Review Agent' })).not.toBeInTheDocument();
  });

  it('opens edit from the target agent menu instead of the previously selected agent', async () => {
    const user = userEvent.setup();
    render(<AgentCenterDemo onBack={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Code Review Agent 更多操作' }));
    const menu = screen.getByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: '编辑配置' }));

    expect(screen.getByLabelText('名称')).toHaveValue('Code Review Agent');
    expect(screen.getByRole('heading', { name: '编辑 Agent' })).toBeVisible();
  });

  it('copies the selected agent into a new editable agent and saves it as a new list item', async () => {
    const user = userEvent.setup();
    render(<AgentCenterDemo onBack={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '复制配置' }));

    expect(screen.getByRole('heading', { name: '新建 Agent' })).toBeVisible();
    expect(screen.getByLabelText('Agent 名称')).toHaveValue('Code Review Agent-复制');
    expect(screen.getByLabelText('简介')).toHaveValue('面向 Git diff、上下文代码和项目规范做系统化代码审查，输出可定位、可复现、可执行的修改建议。');
    expect((screen.getByLabelText('系统提示词') as HTMLTextAreaElement).value).toContain('Code Review Agent');

    await user.click(screen.getByRole('button', { name: '保存配置' }));

    expect(screen.getByRole('button', { name: 'Code Review Agent-复制 更多操作' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Code Review Agent-复制' })).toBeVisible();
  });

  it('shows the built-in Code Review Agent inputs, dimensions, and structured result demo', async () => {
    render(<AgentCenterDemo onBack={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Code Review Agent' })).toBeVisible();
    const demo = await screen.findByRole('region', { name: 'Code Review Demo' });
    expect(screen.getByText('Git diff')).toBeInTheDocument();
    expect(screen.getByText('安全、权限和数据泄露')).toBeInTheDocument();
    expect(within(demo).getByRole('button', { name: '确定问题' })).toBeInTheDocument();
    expect(within(demo).getByRole('button', { name: '人工确认风险' })).toBeInTheDocument();
    expect(screen.getByText('src/auth/session.ts · L42-L58')).toBeInTheDocument();
    expect(screen.getByText('缺少权限边界校验，普通用户可能访问管理员数据')).toBeInTheDocument();
  });

  it('shows behavior rules and a directory chooser in the editor', async () => {
    const user = userEvent.setup();
    render(<AgentCenterDemo onBack={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '编辑配置' }));
    expect(screen.getByRole('heading', { name: '编辑 Agent' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '行为规则' })).toBeInTheDocument();
    expect(screen.getByLabelText('系统提示词')).toBeInTheDocument();
    expect(screen.getByLabelText('行为规则')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择文件夹' })).toBeInTheDocument();
    expect(screen.getByLabelText('工作目录')).toBeInTheDocument();

    vi.mocked(terminalApi.chooseWorkingDirectory).mockResolvedValue('/tmp/selected-agent');
    await user.click(screen.getByRole('button', { name: '选择文件夹' }));
    expect(await screen.findByLabelText('工作目录')).toHaveValue('/tmp/selected-agent');
  });

  it('blocks saving a new agent when its working directory is invalid', async () => {
    const user = userEvent.setup();
    vi.mocked(terminalApi.validateWorkingDirectory).mockRejectedValue(new Error('工作目录不存在: /missing'));
    render(<AgentCenterDemo onBack={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '新建 Agent' }));
    await user.type(screen.getByLabelText('Agent 名称'), '测试 Agent');
    await user.type(screen.getByLabelText('简介'), '用于测试工作目录校验');
    await user.type(screen.getByLabelText('系统提示词'), '请遵循测试规则');
    const cwd = screen.getByLabelText('工作目录');
    await user.clear(cwd);
    await user.type(cwd, '/missing');
    await user.click(screen.getByRole('button', { name: '保存配置' }));

    expect(await screen.findByText('工作目录不存在: /missing')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '新建 Agent' })).toBeInTheDocument();
    expect(terminalApi.validateWorkingDirectory).toHaveBeenCalledWith('/missing');
  });

  it('validates an edited agent directory and supports Finder and clear actions', async () => {
    const user = userEvent.setup();
    render(<AgentCenterDemo onBack={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '编辑配置' }));
    await user.click(screen.getByRole('button', { name: '在 Finder 中打开' }));
    expect(terminalApi.openWorkingDirectory).toHaveBeenCalledWith('/tmp/agentbox-project');

    await user.click(screen.getByRole('button', { name: '清空工作目录' }));
    expect(screen.getByLabelText('工作目录')).toHaveValue('');
  });

  it('lets a new agent select skills from the installed skill list', async () => {
    const user = userEvent.setup();
    vi.mocked(terminalApi.listAgentSkills).mockResolvedValue([{
      agent: 'claude',
      command: 'project-logs',
      description: '查询并分析服务日志',
      name: 'project-logs',
      path: '/Users/example/.claude/skills/project-logs/SKILL.md',
      source: '本地',
    }]);
    render(<AgentCenterDemo onBack={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '新建 Agent' }));
    await user.click(screen.getByRole('button', { name: '添加 Skill' }));

    expect(await screen.findByRole('heading', { name: '添加 Skill' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /project-logs/ }));
    await user.click(screen.getByRole('button', { name: '确认（1）' }));

    expect(screen.getByText('project-logs')).toBeInTheDocument();
    expect(screen.queryByLabelText('Skill 列表')).not.toBeInTheDocument();
  });

  it('allows behavior rules to be entered on multiple lines', async () => {
    const user = userEvent.setup();
    render(<AgentCenterDemo onBack={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '编辑配置' }));
    const textarea = screen.getByLabelText('行为规则');
    await user.clear(textarea);
    await user.type(textarea, '先给结论{enter}再展开分析');

    expect(textarea).toHaveValue('先给结论\n再展开分析');
  });

  it('deletes the selected agent and moves selection to the next available agent', async () => {
    const user = userEvent.setup();
    render(<AgentCenterDemo onBack={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '需求分析 Agent 更多操作' }));
    const menu = screen.getByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: '删除 Agent' }));

    expect(screen.getByRole('dialog', { name: '删除 Agent' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认删除' }));

    expect(screen.queryByRole('button', { name: /需求分析 Agent 更多操作/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Code Review Agent' })).toBeVisible();
  });

  it('shows related session count and preserves historical sessions before deleting an agent', async () => {
    const user = userEvent.setup();
    vi.mocked(promptpadStorage.loadAiWorkspace).mockResolvedValue({
      ...emptyArchive(),
      sessions: [
        session({ id: 'requirement-session-1', agentConfig: { agentId: 'requirement', agentName: '需求分析 Agent' } }),
        session({ id: 'requirement-session-2', agentConfig: { agentId: 'requirement', agentName: '需求分析 Agent' } }),
      ],
    });
    render(<AgentCenterDemo onBack={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '需求分析 Agent 更多操作' }));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: '删除 Agent' }));

    expect(screen.getByText('该 Agent 关联 2 个历史会话')).toBeInTheDocument();
    expect(screen.getByText('删除 Agent 配置不会删除历史会话和会话内容。')).toBeInTheDocument();
    expect(screen.getByText('删除后配置本身无法恢复。')).toBeInTheDocument();
    expect(promptpadStorage.loadAiWorkspace).toHaveBeenCalledTimes(1);
  });
});
