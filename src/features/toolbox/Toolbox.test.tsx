import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Toolbox } from './Toolbox';
import type { NormalizedFeatureDef, Prefs } from '../../shared/types';

const features: NormalizedFeatureDef[] = [
  {
    id: 'builtin-promptpad',
    name: 'PromptPad',
    description: '浮动输入窗口',
    script: '',
    extra: '',
    builtin: true,
    type: 'prompt',
    agent: 'claude',
    autoRun: false,
    seqRule: 'auto',
    seqTerm: 'plain',
  },
  {
    id: 'custom-url',
    name: '接口文档',
    description: '打开 ZAPI',
    script: 'zapi.example.com',
    extra: '',
    builtin: false,
    type: 'url',
    agent: 'claude',
    autoRun: false,
    seqRule: 'auto',
    seqTerm: 'plain',
  },
  {
    id: 'custom-agent',
    name: 'Codex Review',
    description: '启动 codex',
    script: 'review changes',
    extra: '',
    builtin: false,
    type: 'agent',
    agent: 'codex',
    autoRun: false,
    seqRule: 'auto',
    seqTerm: 'plain',
  },
  {
    id: 'custom-prompt',
    name: '提示词助手',
    description: '填入提示词',
    script: 'help me',
    extra: '',
    builtin: false,
    type: 'prompt',
    agent: 'claude',
    autoRun: false,
    seqRule: 'auto',
    seqTerm: 'plain',
  },
];

const prefs: Prefs = {
  favorites: ['custom-url'],
  order: features.map((feature) => feature.id),
};

describe('Toolbox', () => {
  it('renders builtin and custom features', () => {
    renderToolbox();

    const promptPadCard = screen.getByText('PromptPad').closest('article');
    expect(promptPadCard).not.toBeNull();
    expect(within(promptPadCard as HTMLElement).getByText('内置')).toBeInTheDocument();
    expect(screen.getByText('接口文档')).toBeInTheDocument();
    expect(screen.getByText('Codex Review')).toBeInTheDocument();
  });

  it('filters features by keyword', async () => {
    const user = userEvent.setup();
    renderToolbox();

    await user.type(screen.getByPlaceholderText('搜索功能'), '接口');

    expect(screen.getByText('接口文档')).toBeInTheDocument();
    expect(screen.queryByText('PromptPad')).not.toBeInTheDocument();
  });

  it('filters features by type', async () => {
    const user = userEvent.setup();
    renderToolbox();

    await user.selectOptions(screen.getByLabelText('类型筛选'), 'agent');

    expect(screen.getByText('Codex Review')).toBeInTheDocument();
    expect(screen.queryByText('接口文档')).not.toBeInTheDocument();
  });

  it('groups feature actions behind a menu and removes up and down actions', async () => {
    const user = userEvent.setup();
    renderToolbox();

    await user.click(screen.getByRole('button', { name: '接口文档 功能操作' }));

    expect(screen.getByRole('menuitem', { name: '运行' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '取消收藏' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '置顶' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '编辑' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '删除' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '上移' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下移' })).not.toBeInTheDocument();
  });

  it('pins a feature to the top of the current type filter only', async () => {
    const user = userEvent.setup();
    const onPrefsChange = vi.fn();
    renderToolbox({
      onPrefsChange,
      prefs: {
        favorites: [],
        order: ['custom-url', 'builtin-promptpad', 'custom-agent', 'custom-prompt'],
      },
    });

    await user.selectOptions(screen.getByLabelText('类型筛选'), 'prompt');
    await user.click(screen.getByRole('button', { name: '提示词助手 功能操作' }));
    await user.click(screen.getByRole('menuitem', { name: '置顶' }));

    expect(onPrefsChange).toHaveBeenCalledWith({
      favorites: [],
      order: ['custom-url', 'custom-prompt', 'builtin-promptpad', 'custom-agent'],
    });
  });
});

function renderToolbox(overrides: Partial<Parameters<typeof Toolbox>[0]> = {}) {
  return render(
    <Toolbox
      features={features}
      prefs={prefs}
      onPrefsChange={vi.fn()}
      onInvoke={vi.fn()}
      onCreate={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      {...overrides}
    />,
  );
}
