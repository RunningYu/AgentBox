import type {
  AgentType,
  FeatureDef,
  FeatureType,
  NormalizedFeatureDef,
  SequenceRule,
  SequenceTerminal,
} from './types';

export const BUILTIN_PROMPTPAD_ID = 'builtin-promptpad';
export const BUILTIN_JSON_FORMAT_ID = 'builtin-json-format';
export const SEQUENCE_STEP_SEPARATOR = '\n@@@STEP@@@\n';

const FEATURE_TYPES: FeatureType[] = ['prompt', 'agent', 'url', 'snippet', 'sequence'];

export function builtinFeatures(): NormalizedFeatureDef[] {
  return [
    normalizeFeature({
      id: BUILTIN_PROMPTPAD_ID,
      name: 'PromptPad',
      description:
        '浮动输入窗口：弹出一个可自由编辑的输入框，写完把内容送回当前编辑器/终端光标处。',
      script: null,
      extra: null,
      builtin: true,
      type: 'prompt',
    }),
    normalizeFeature({
      id: BUILTIN_JSON_FORMAT_ID,
      name: 'JSON 格式化',
      description: '左边粘 JSON，右边实时格式化，两侧均可一键复制。',
      script: null,
      extra: null,
      builtin: true,
      type: 'prompt',
    }),
  ];
}

export function normalizeFeature(feature: FeatureDef): NormalizedFeatureDef {
  return {
    ...feature,
    script: feature.script ?? '',
    extra: feature.extra ?? '',
    type: normalizeType(feature.type),
    agent: normalizeAgent(feature.agent),
    autoRun: Boolean(feature.autoRun),
    seqRule: normalizeSequenceRule(feature.seqRule),
    seqTerm: normalizeSequenceTerminal(feature.seqTerm),
  };
}

export function splitSequenceSteps(script: string | null | undefined): string[] {
  if (!script) {
    return [];
  }
  return script
    .split(SEQUENCE_STEP_SEPARATOR)
    .map((step) => step.trim())
    .filter(Boolean);
}

export function joinSequenceSteps(steps: string[]): string {
  return steps.map((step) => step.trim()).filter(Boolean).join(SEQUENCE_STEP_SEPARATOR);
}

function normalizeType(type: string | null | undefined): FeatureType {
  return FEATURE_TYPES.includes(type as FeatureType) ? (type as FeatureType) : 'prompt';
}

function normalizeAgent(agent: string | null | undefined): AgentType {
  return agent === 'codex' ? 'codex' : 'claude';
}

function normalizeSequenceRule(rule: string | null | undefined): SequenceRule {
  return rule === 'confirm' ? 'confirm' : 'auto';
}

function normalizeSequenceTerminal(term: string | null | undefined): SequenceTerminal {
  if (term === 'claude' || term === 'codex') {
    return term;
  }
  return 'plain';
}
