import { describe, expect, it } from 'vitest';
import { normalizeFeature } from '../../shared/featureModel';
import type { NormalizedFeatureDef, Prefs } from '../../shared/types';
import { applyToolboxImport, createToolboxExportPayload, parseToolboxImportFile } from './toolboxTransfer';

describe('toolboxTransfer', () => {
  it('exports only the selected custom feature fields and scoped prefs', () => {
    const features = [
      feature({ id: 'prompt-a', name: '提示词 A' }),
      feature({ id: 'workflow-a', name: '工作流 A', type: 'sequence' }),
    ];
    const payload = createToolboxExportPayload(features, {
      favorites: ['prompt-a', 'missing'],
      order: ['missing', 'workflow-a', 'prompt-a'],
    });

    expect(payload.app).toBe('agentbox');
    expect(payload.schemaVersion).toBe(1);
    expect(payload.features).toHaveLength(2);
    expect(payload.features[0].builtin).toBe(false);
    expect(payload.prefs).toEqual({
      favorites: ['prompt-a'],
      order: ['workflow-a', 'prompt-a'],
    });
  });

  it('skips conflicting imported features by default', () => {
    const existing = [feature({ id: 'local-a', name: '同名提示词' })];
    const preview = parseToolboxImportFile('/tmp/tools.json', JSON.stringify({
      app: 'agentbox',
      schemaVersion: 1,
      exportedAt: '2026-08-05T00:00:00.000Z',
      features: [
        { id: 'remote-a', name: '同名提示词', description: '远端', script: 'remote', builtin: false, type: 'prompt' },
        { id: 'remote-b', name: '新增提示词', description: '新增', script: 'new', builtin: false, type: 'prompt' },
      ],
      prefs: { favorites: ['remote-a', 'remote-b'], order: ['remote-a', 'remote-b'] },
    }), existing);

    const result = applyToolboxImport(preview, existing, prefs(['local-a']), 'skip');

    expect(result.features.map((item) => item.name)).toEqual(['同名提示词', '新增提示词']);
    expect(result.features.find((item) => item.id === 'local-a')?.script).toBe('');
    expect(result.addedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.prefs.favorites).toContain('local-a');
    expect(result.prefs.favorites).toContain('remote-b');
  });

  it('overwrites or duplicates conflicting features based on the chosen strategy', () => {
    const existing = [feature({ id: 'local-a', name: '同名提示词', script: 'local' })];
    const preview = parseToolboxImportFile('/tmp/tools.json', JSON.stringify({
      app: 'agentbox',
      schemaVersion: 1,
      features: [
        { id: 'remote-a', name: '同名提示词', description: '远端', script: 'remote', builtin: false, type: 'prompt' },
      ],
    }), existing);

    const overwritten = applyToolboxImport(preview, existing, prefs(['local-a']), 'overwrite');
    expect(overwritten.features).toHaveLength(1);
    expect(overwritten.features[0]).toEqual(expect.objectContaining({ id: 'local-a', script: 'remote' }));
    expect(overwritten.overwrittenCount).toBe(1);

    const duplicated = applyToolboxImport(preview, existing, prefs(['local-a']), 'duplicate');
    expect(duplicated.features).toHaveLength(2);
    expect(duplicated.features[1].name).toBe('同名提示词 导入');
    expect(duplicated.duplicatedCount).toBe(1);
  });

  it('rejects unsupported import files', () => {
  expect(() => parseToolboxImportFile('/tmp/bad.json', '{"features":[]}', [])).toThrow(/AgentBox/);
  });
});

function feature(overrides: Partial<NormalizedFeatureDef> = {}): NormalizedFeatureDef {
  return normalizeFeature({
    id: overrides.id ?? 'feature-a',
    name: overrides.name ?? '功能',
    description: overrides.description ?? '',
    script: overrides.script ?? '',
    extra: overrides.extra ?? '',
    builtin: false,
    type: overrides.type ?? 'prompt',
    agent: overrides.agent ?? 'claude',
    autoRun: overrides.autoRun ?? false,
    seqRule: overrides.seqRule ?? 'auto',
    seqTerm: overrides.seqTerm ?? 'plain',
  });
}

function prefs(order: string[]): Prefs {
  return { favorites: [], order };
}
