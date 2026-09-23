import type { AgentType, FeatureType, NormalizedFeatureDef, SequenceRule, SequenceTerminal } from '../../shared/types';
import { SEQUENCE_STEP_SEPARATOR } from '../../shared/featureModel';

interface FeatureEditorProps {
  canEditType?: boolean;
  value: NormalizedFeatureDef;
  onChange: (feature: NormalizedFeatureDef) => void;
  onCancel: () => void;
  onSave: () => void;
}

export function FeatureEditor({ canEditType = true, value, onChange, onCancel, onSave }: FeatureEditorProps) {
  const sequenceSteps = editableSequenceSteps(value.script);
  const editing = !canEditType;

  function updateSequenceSteps(steps: string[]) {
    onChange({ ...value, script: steps.join(SEQUENCE_STEP_SEPARATOR) });
  }

  function moveSequenceStep(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= sequenceSteps.length) {
      return;
    }
    const next = [...sequenceSteps];
    [next[index], next[target]] = [next[target], next[index]];
    updateSequenceSteps(next);
  }

  function deleteSequenceStep(index: number) {
    const next = sequenceSteps.filter((_, itemIndex) => itemIndex !== index);
    updateSequenceSteps(next.length > 0 ? next : ['']);
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-label="功能编辑" className="feature-editor">
        <header>
          <div>
            <span className={`type-badge type-${value.type}`}>{typeLabel(value.type)}</span>
            <h2>{editing ? '编辑功能' : '新增功能'}</h2>
          </div>
        </header>
        <div className="feature-editor-body">
          <div className="feature-editor-card">
            <div className="feature-editor-main-grid">
              <label>
                名称
                <input value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} />
              </label>
              <label>
                类型
                <select
                  disabled={!canEditType}
                  value={value.type}
                  onChange={(event) => onChange({ ...value, type: event.target.value as FeatureType })}
                >
                  <option value="prompt">提示词</option>
                  <option value="agent">Agent</option>
                  <option value="url">URL</option>
                  <option value="snippet">片段</option>
                  <option value="sequence">工作流</option>
                </select>
              </label>
            </div>
            <label>
              介绍
              <input
                value={value.description}
                onChange={(event) => onChange({ ...value, description: event.target.value })}
              />
            </label>
          </div>
          {value.type === 'agent' && (
            <div className="feature-editor-card">
              <label>
                Agent
                <select
                  value={value.agent}
                  onChange={(event) => onChange({ ...value, agent: event.target.value as AgentType })}
                >
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
            </div>
          )}
          {value.type === 'sequence' && (
            <div className="feature-editor-card editor-grid">
              <label>
                执行规则
                <select
                  value={value.seqRule}
                  onChange={(event) => onChange({ ...value, seqRule: event.target.value as SequenceRule })}
                >
                  <option value="auto">自动</option>
                  <option value="confirm">逐步确认</option>
                </select>
              </label>
              <label>
                终端类型
                <select
                  value={value.seqTerm}
                  onChange={(event) => onChange({ ...value, seqTerm: event.target.value as SequenceTerminal })}
                >
                  <option value="plain">普通 shell</option>
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
            </div>
          )}
          {value.type === 'prompt' && (
            <label className="check-row">
              <input
                checked={value.autoRun}
                onChange={(event) => onChange({ ...value, autoRun: event.target.checked })}
                type="checkbox"
              />
              粘贴后自动执行
            </label>
          )}
          {value.type === 'sequence' ? (
            <div className="sequence-step-editor">
              {sequenceSteps.map((step, index) => (
                <section className="sequence-step-field" key={index}>
                  <header>
                    <strong>步骤 {index + 1}</strong>
                    <span>
                      <button onClick={() => moveSequenceStep(index, -1)} type="button">上移</button>
                      <button onClick={() => moveSequenceStep(index, 1)} type="button">下移</button>
                      <button onClick={() => deleteSequenceStep(index)} type="button">删除</button>
                    </span>
                  </header>
                  <textarea
                    aria-label={`步骤 ${index + 1}`}
                    value={step}
                    onChange={(event) => updateSequenceSteps(sequenceSteps.map((item, itemIndex) => (
                      itemIndex === index ? event.target.value : item
                    )))}
                  />
                </section>
              ))}
              <button onClick={() => updateSequenceSteps([...sequenceSteps, ''])} type="button">添加步骤</button>
            </div>
          ) : (
            <div className="feature-editor-card">
              <label>
                脚本 / 内容
                <textarea value={value.script ?? ''} onChange={(event) => onChange({ ...value, script: event.target.value })} />
              </label>
            </div>
          )}
          <div className="feature-editor-card">
            <label>
              其他
              <textarea value={value.extra ?? ''} onChange={(event) => onChange({ ...value, extra: event.target.value })} />
            </label>
          </div>
        </div>
        <footer>
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button className="primary-button" onClick={onSave} type="button">
            保存
          </button>
        </footer>
      </section>
    </div>
  );
}

function editableSequenceSteps(script: string | null | undefined) {
  if (!script) {
    return [''];
  }
  return script.split(SEQUENCE_STEP_SEPARATOR);
}

function typeLabel(type: FeatureType) {
  switch (type) {
    case 'agent':
      return 'Agent';
    case 'url':
      return 'URL';
    case 'snippet':
      return '片段';
    case 'sequence':
      return '工作流';
    case 'prompt':
    default:
      return '提示词';
  }
}
