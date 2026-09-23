import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PluginWindowPage } from './PluginWindowPage';

const { emitTo } = vi.hoisted(() => ({ emitTo: vi.fn() }));

vi.mock('@tauri-apps/api/event', () => ({
  emitTo,
  listen: vi.fn(async (_name: string, callback: (event: { payload: { sessionId: string; groupId: string | null } }) => void) => {
    callback({ payload: { sessionId: 'session-1', groupId: null } });
    return vi.fn();
  }),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ close: vi.fn() }),
}));

vi.mock('../../shared/promptpadStorage', () => ({
  loadCustomFeatures: vi.fn(async () => [{
    id: 'workflow-1',
    name: '发布检查',
    description: '执行发布前检查',
    script: '检查构建\n@@@STEP@@@\n检查配置',
    extra: '',
    builtin: false,
    type: 'sequence',
    agent: 'claude',
    autoRun: false,
    seqRule: 'confirm',
    seqTerm: 'plain',
  }]),
}));

describe('PluginWindowPage', () => {
  it('renders the complete plugin page and sends an insert request', async () => {
    const user = userEvent.setup();
    render(<PluginWindowPage pluginId="workflow-1" />);

    expect(await screen.findByRole('heading', { name: '发布检查' })).toBeInTheDocument();
    expect(screen.getByText('检查构建')).toBeInTheDocument();
    expect(screen.getByText('检查配置')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: '插入当前会话' })[0]);
    expect(emitTo).toHaveBeenCalledWith('main', 'plugin-window-insert', expect.objectContaining({
      featureId: 'workflow-1',
      text: '检查构建',
    }));
  });
});
