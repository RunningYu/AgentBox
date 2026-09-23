import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { NormalizedFeatureDef, Prefs } from '../../shared/types';
import { AiToolPanel } from './AiToolPanel';

const features: NormalizedFeatureDef[] = [
  feature({ id: 'prompt-a', name: '提示词 A', type: 'prompt' }),
  feature({ id: 'agent-b', name: 'Agent B', type: 'agent' }),
  feature({ id: 'prompt-c', name: '提示词 C', type: 'prompt' }),
];

describe('AiToolPanel', () => {
  it('filters favorite tools from the AI toolbox panel', async () => {
    const user = userEvent.setup();
    render(
      <AiToolPanel
        features={features}
        onCollapse={vi.fn()}
        onInvoke={vi.fn()}
        prefs={{ favorites: ['agent-b'], order: features.map((item) => item.id) }}
      />,
    );

    await user.click(screen.getByRole('button', { name: '常用' }));

    expect(screen.getByText('Agent B')).toBeInTheDocument();
    expect(screen.queryByText('提示词 A')).not.toBeInTheDocument();
    expect(screen.queryByText('提示词 C')).not.toBeInTheDocument();
  });

  it('treats source filters and type filter as mutually exclusive single filters', async () => {
    const user = userEvent.setup();
    render(
      <AiToolPanel
        features={features}
        onCollapse={vi.fn()}
        onInvoke={vi.fn()}
        prefs={{ favorites: ['agent-b'], order: features.map((item) => item.id) }}
      />,
    );

    await user.click(screen.getByRole('button', { name: '常用' }));
    expect(screen.getByRole('button', { name: '常用' })).toHaveClass('active');
    await user.selectOptions(screen.getByLabelText('功能类型筛选'), 'prompt');
    expect(screen.getByLabelText('功能类型筛选')).toHaveValue('prompt');
    expect(screen.getByRole('button', { name: '常用' })).not.toHaveClass('active');
  });

  it('pins a tool and refreshes the visible list immediately', async () => {
    const user = userEvent.setup();
    render(<PanelHarness />);

    await user.click(screen.getByRole('button', { name: '提示词 C 功能操作' }));
    await user.click(screen.getByRole('menuitem', { name: '置顶' }));

    const cards = within(screen.getByLabelText('AI 工具列表')).getAllByRole('article');
    expect(cards.map((card) => card.querySelector('.feature-hit')?.textContent)).toEqual([
      expect.stringContaining('提示词 C'),
      expect.stringContaining('提示词 A'),
      expect.stringContaining('Agent B'),
    ]);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes stale menus after a tool is deleted', async () => {
    const user = userEvent.setup();
    render(<PanelHarness />);

    await user.click(screen.getByRole('button', { name: 'Agent B 功能操作' }));
    await user.click(screen.getByRole('menuitem', { name: '删除' }));

    expect(screen.queryByText('Agent B')).not.toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes an open menu when the selected tool disappears from props', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AiToolPanel
        features={features}
        onCollapse={vi.fn()}
        onDelete={vi.fn()}
        onInvoke={vi.fn()}
        prefs={{ favorites: [], order: features.map((item) => item.id) }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Agent B 功能操作' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    rerender(
      <AiToolPanel
        features={features.filter((item) => item.id !== 'agent-b')}
        onCollapse={vi.fn()}
        onDelete={vi.fn()}
        onInvoke={vi.fn()}
        prefs={{ favorites: [], order: features.map((item) => item.id) }}
      />,
    );

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('reorders a tool when the drag pointer leaves the handle and ends over another card', () => {
    const onPrefsChange = vi.fn();
    render(
      <AiToolPanel
        features={features}
        onCollapse={vi.fn()}
        onInvoke={vi.fn()}
        onPrefsChange={onPrefsChange}
        prefs={{ favorites: [], order: features.map((item) => item.id) }}
      />,
    );

    const list = screen.getByLabelText('AI 工具列表');
    const handles = within(list).getAllByRole('button', { name: /拖动/ });
    const target = within(list).getAllByRole('article')[2];
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({
      bottom: 500,
      height: 500,
      left: 0,
      right: 400,
      top: 0,
      width: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      bottom: 300,
      height: 80,
      left: 0,
      right: 400,
      top: 220,
      width: 400,
      x: 0,
      y: 220,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(handles[0], { button: 0, clientX: 12, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 24, clientY: 40, pointerId: 1 });
    fireEvent.pointerMove(target, { clientX: 24, clientY: 240, pointerId: 1 });
    fireEvent.pointerUp(document, { clientX: 24, clientY: 240, pointerId: 1 });

    expect(onPrefsChange).toHaveBeenCalledWith({
      favorites: [],
      order: ['agent-b', 'prompt-c', 'prompt-a'],
    });
    expect(within(list).getAllByRole('article')).toHaveLength(3);
  });

  it('detaches a tool when the pointer is released outside the panel', () => {
    const onDetach = vi.fn();
    render(
      <AiToolPanel
        features={features}
        onCollapse={vi.fn()}
        onDetach={onDetach}
        onInvoke={vi.fn()}
        prefs={{ favorites: [], order: features.map((item) => item.id) }}
      />,
    );

    const panel = screen.getByRole('complementary');
    const handle = screen.getAllByRole('button', { name: /拖动/ })[0];
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({
      bottom: 500,
      height: 500,
      left: 0,
      right: 400,
      top: 0,
      width: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(handle, { button: 0, clientX: 12, clientY: 20, pointerId: 2 });
    fireEvent.pointerMove(handle, { clientX: 460, clientY: 40, pointerId: 2 });
    fireEvent.blur(window);

    expect(onDetach).toHaveBeenCalledWith(features[0]);
  });
});

function PanelHarness() {
  const [items, setItems] = useState(features);
  const [prefs, setPrefs] = useState<Prefs>({ favorites: [], order: features.map((item) => item.id) });
  return (
    <AiToolPanel
      features={items}
      onCollapse={vi.fn()}
      onDelete={(featureDef) => setItems((current) => current.filter((item) => item.id !== featureDef.id))}
      onInvoke={vi.fn()}
      onPrefsChange={setPrefs}
      prefs={prefs}
    />
  );
}

function feature(overrides: Pick<NormalizedFeatureDef, 'id' | 'name' | 'type'>): NormalizedFeatureDef {
  return {
    agent: 'claude',
    autoRun: false,
    builtin: false,
    description: `${overrides.name} 简介`,
    extra: '',
    script: `${overrides.name} 内容`,
    seqRule: 'auto',
    seqTerm: 'plain',
    ...overrides,
  };
}
