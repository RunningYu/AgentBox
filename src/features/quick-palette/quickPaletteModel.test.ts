import { describe, expect, it } from 'vitest';
import { normalizeQuickPalettePrefs, visiblePaletteFeatures } from './quickPaletteModel';
import { normalizeFeature } from '../../shared/featureModel';

const features = [
  normalizeFeature({ id: 'a', name: '日志分析', description: '分析线上日志', builtin: false, type: 'prompt' }),
  normalizeFeature({ id: 'b', name: 'JSON 片段', description: '常用数据', builtin: false, type: 'snippet' }),
];

describe('quickPaletteModel', () => {
  it('adds safe defaults without dropping existing preferences', () => {
    expect(normalizeQuickPalettePrefs({ favorites: ['a'], order: ['b', 'a'] })).toEqual({
      favorites: ['a'],
      order: ['b', 'a'],
      globalShortcut: 'Control+Option+Space',
      quickPaletteSubmitMode: 'insert',
    });
  });

  it('searches features and supports favorite and type filters', () => {
    expect(visiblePaletteFeatures(features, { keyword: '日志', source: 'all', type: 'all' }, ['a']).map((item) => item.id)).toEqual(['a']);
    expect(visiblePaletteFeatures(features, { keyword: '', source: 'favorite', type: 'all' }, ['a']).map((item) => item.id)).toEqual(['a']);
    expect(visiblePaletteFeatures(features, { keyword: '', source: 'all', type: 'snippet' }, ['a']).map((item) => item.id)).toEqual(['b']);
  });
});
