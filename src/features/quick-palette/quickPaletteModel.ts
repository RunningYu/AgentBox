import type { FeatureType, NormalizedFeatureDef, Prefs } from '../../shared/types';

export const DEFAULT_GLOBAL_SHORTCUT = 'Control+Option+Space';

export type PaletteFilter = {
  keyword: string;
  source: 'all' | 'favorite';
  type: 'all' | FeatureType;
};

export function normalizeQuickPalettePrefs(prefs: Prefs): Prefs {
  return {
    ...prefs,
    globalShortcut: prefs.globalShortcut || DEFAULT_GLOBAL_SHORTCUT,
    quickPaletteSubmitMode: prefs.quickPaletteSubmitMode === 'insert-and-send' ? 'insert-and-send' : 'insert',
  };
}

export function visiblePaletteFeatures(
  features: NormalizedFeatureDef[],
  filter: PaletteFilter,
  favorites: string[],
): NormalizedFeatureDef[] {
  const keyword = filter.keyword.trim().toLowerCase();
  return features.filter((feature) => {
    if (filter.source === 'favorite' && !favorites.includes(feature.id)) return false;
    if (filter.type !== 'all' && feature.type !== filter.type) return false;
    return !keyword || `${feature.name} ${feature.description}`.toLowerCase().includes(keyword);
  });
}
