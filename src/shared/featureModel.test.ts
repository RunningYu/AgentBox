import { describe, expect, it } from 'vitest';
import {
  builtinFeatures,
  joinSequenceSteps,
  normalizeFeature,
  splitSequenceSteps,
} from './featureModel';

describe('feature model compatibility', () => {
  it('defaults unknown feature types to prompt', () => {
    const feature = normalizeFeature({
      id: 'custom-1',
      name: 'Legacy',
      description: 'old data',
      script: 'echo ok',
      builtin: false,
      type: 'unknown',
    });

    expect(feature.type).toBe('prompt');
    expect(feature.agent).toBe('claude');
    expect(feature.seqRule).toBe('auto');
    expect(feature.seqTerm).toBe('plain');
  });

  it('splits and joins sequence steps using the plugin separator', () => {
    const steps = splitSequenceSteps('npm test\n@@@STEP@@@\nnpm run build\n@@@STEP@@@\n  ');

    expect(steps).toEqual(['npm test', 'npm run build']);
    expect(joinSequenceSteps(steps)).toBe('npm test\n@@@STEP@@@\nnpm run build');
  });

  it('provides the same builtin feature ids as the IntelliJ plugin', () => {
    const ids = builtinFeatures().map((feature) => feature.id);

    expect(ids).toContain('builtin-promptpad');
    expect(ids).toContain('builtin-json-format');
  });
});
