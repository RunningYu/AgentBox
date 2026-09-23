import { describe, expect, it } from 'vitest';
import { buildFeatureAction, normalizeUrl } from './featureRunner';
import type { NormalizedFeatureDef } from '../../shared/types';

describe('feature runner', () => {
  it('normalizes urls without a protocol to https', () => {
    expect(normalizeUrl('zapi.example.com/docs')).toBe('https://zapi.example.com/docs');
    expect(normalizeUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeUrl('mailto:dev@example.com')).toBe('mailto:dev@example.com');
  });

  it('builds prompt and snippet clipboard actions', () => {
    expect(buildFeatureAction(feature({ type: 'prompt', script: 'npm test', autoRun: true }))).toEqual({
      kind: 'paste',
      text: 'npm test',
      appendEnter: true,
    });
    expect(buildFeatureAction(feature({ type: 'snippet', script: 'hello' }))).toEqual({
      kind: 'paste',
      text: 'hello',
      appendEnter: false,
    });
  });

  it('builds agent and sequence actions for macOS Terminal', () => {
    expect(buildFeatureAction(feature({ type: 'agent', agent: 'codex', script: 'review' }))).toEqual({
      kind: 'system-terminal',
      command: 'codex',
      input: 'review',
    });
    expect(
      buildFeatureAction(
        feature({
          type: 'sequence',
          seqTerm: 'claude',
          script: 'step one\n@@@STEP@@@\nstep two',
        }),
      ),
    ).toEqual({
      kind: 'system-terminal',
      command: 'claude',
      input: 'step one\nstep two',
    });
  });

  it('builds plain sequence actions for macOS Terminal', () => {
    expect(
      buildFeatureAction(
        feature({
          type: 'sequence',
          seqTerm: 'plain',
          script: 'npm test\n@@@STEP@@@\nnpm run build',
        }),
      ),
    ).toEqual({
      kind: 'system-terminal',
      command: 'npm test\nnpm run build',
    });
  });
});

function feature(overrides: Partial<NormalizedFeatureDef>): NormalizedFeatureDef {
  return {
    id: 'custom-test',
    name: 'Test',
    description: 'Test feature',
    script: '',
    extra: '',
    builtin: false,
    type: 'prompt',
    agent: 'claude',
    autoRun: false,
    seqRule: 'auto',
    seqTerm: 'plain',
    ...overrides,
  };
}
