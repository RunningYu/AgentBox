import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { normalizeFeature } from '../../shared/featureModel';
import { FeatureEditor } from './FeatureEditor';

describe('FeatureEditor', () => {
  it('locks the feature type when editing an existing feature', () => {
    render(
      <FeatureEditor
        canEditType={false}
        onCancel={vi.fn()}
        onChange={vi.fn()}
        onSave={vi.fn()}
        value={normalizeFeature({
          id: 'custom-review',
          name: '本地代码审查',
          description: '审查提示词',
          script: 'review',
          builtin: false,
          type: 'prompt',
        })}
      />,
    );

    expect(screen.getByLabelText('类型')).toBeDisabled();
  });

  it('edits confirm sequence content as separate movable steps', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FeatureEditor
        onCancel={vi.fn()}
        onChange={onChange}
        onSave={vi.fn()}
        value={normalizeFeature({
          id: 'custom-sequence',
          name: '逐步工作流',
          description: '分步执行',
          script: '步骤一\n@@@STEP@@@\n步骤二',
          builtin: false,
          type: 'sequence',
          seqRule: 'confirm',
        })}
      />,
    );

    expect(screen.getByLabelText('步骤 1')).toHaveValue('步骤一');
    expect(screen.getByLabelText('步骤 2')).toHaveValue('步骤二');

    await user.click(screen.getByRole('button', { name: '添加步骤' }));

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      script: '步骤一\n@@@STEP@@@\n步骤二\n@@@STEP@@@\n',
    }));
  });

  it('adds a visible empty step textarea in the controlled editor', async () => {
    const user = userEvent.setup();
    render(<ControlledSequenceEditor />);

    expect(screen.getAllByLabelText(/步骤 \d+/)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '添加步骤' }));

    expect(screen.getAllByLabelText(/步骤 \d+/)).toHaveLength(2);
    expect(screen.getByLabelText('步骤 2')).toHaveValue('');
  });

  it('shows each step number only once', () => {
    render(
      <FeatureEditor
        onCancel={vi.fn()}
        onChange={vi.fn()}
        onSave={vi.fn()}
        value={normalizeFeature({
          id: 'custom-sequence',
          name: '逐步工作流',
          description: '分步执行',
          script: '步骤一\n@@@STEP@@@\n步骤二',
          builtin: false,
          type: 'sequence',
          seqRule: 'confirm',
        })}
      />,
    );

    expect(screen.getAllByText('步骤 1')).toHaveLength(1);
    expect(screen.getAllByText('步骤 2')).toHaveLength(1);
  });

  it('edits auto sequence content as movable steps too', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FeatureEditor
        onCancel={vi.fn()}
        onChange={onChange}
        onSave={vi.fn()}
        value={normalizeFeature({
          id: 'custom-sequence',
          name: '自动工作流',
          description: '自动执行',
          script: '命令一\n命令二',
          builtin: false,
          type: 'sequence',
          seqRule: 'auto',
        })}
      />,
    );

    expect(screen.getByLabelText('步骤 1')).toHaveValue('命令一\n命令二');

    await user.click(screen.getByRole('button', { name: '添加步骤' }));

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      script: '命令一\n命令二\n@@@STEP@@@\n',
    }));
  });

  it('uses the create title when adding a new feature', () => {
    render(
      <FeatureEditor
        canEditType
        onCancel={vi.fn()}
        onChange={vi.fn()}
        onSave={vi.fn()}
        value={normalizeFeature({
          id: 'custom-new-feature',
          name: '',
          description: '',
          script: '',
          builtin: false,
          type: 'prompt',
        })}
      />,
    );

    expect(screen.getByRole('heading', { name: '新增功能' })).toBeInTheDocument();
  });

  it('keeps cancel and save outside the scrolling editor body', () => {
    render(
      <FeatureEditor
        onCancel={vi.fn()}
        onChange={vi.fn()}
        onSave={vi.fn()}
        value={normalizeFeature({
          id: 'long-sequence',
          name: '长工作流',
          description: '很多步骤',
          script: Array.from({ length: 16 }, (_, index) => `步骤 ${index + 1}`).join('\n@@@STEP@@@\n'),
          builtin: false,
          type: 'sequence',
          seqRule: 'confirm',
        })}
      />,
    );

    const editor = screen.getByLabelText('功能编辑');
    const body = editor.querySelector('.feature-editor-body');
    const footer = editor.querySelector('footer');

    expect(body).toBeInTheDocument();
    expect(footer).toBeInTheDocument();
    expect(body).not.toContainElement(screen.getByRole('button', { name: '取消' }));
    expect(footer).toContainElement(screen.getByRole('button', { name: '取消' }));
    expect(footer).toContainElement(screen.getByRole('button', { name: '保存' }));
  });
});

function ControlledSequenceEditor() {
  const [feature, setFeature] = useState(() => normalizeFeature({
    id: 'custom-sequence',
    name: '逐步工作流',
    description: '分步执行',
    script: '步骤一',
    builtin: false,
    type: 'sequence',
    seqRule: 'confirm',
  }));

  return <FeatureEditor onCancel={vi.fn()} onChange={setFeature} onSave={vi.fn()} value={feature} />;
}
