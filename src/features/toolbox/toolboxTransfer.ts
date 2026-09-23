import { invoke } from '@tauri-apps/api/core';
import { normalizeFeature } from '../../shared/featureModel';
import type { FeatureDef, NormalizedFeatureDef, Prefs } from '../../shared/types';

export type ToolboxExportScope = 'all' | 'filtered' | 'selected';
export type ToolboxImportConflictStrategy = 'skip' | 'overwrite' | 'duplicate';

export interface ToolboxExportPayload {
  app: 'agentbox';
  schemaVersion: 1;
  exportedAt: string;
  features: FeatureDef[];
  prefs?: Partial<Prefs>;
}

export interface ToolboxImportPreview {
  path: string;
  payload: ToolboxExportPayload;
  features: NormalizedFeatureDef[];
  added: NormalizedFeatureDef[];
  conflicted: NormalizedFeatureDef[];
  invalidCount: number;
}

export interface ToolboxImportResult {
  features: NormalizedFeatureDef[];
  prefs: Prefs;
  addedCount: number;
  overwrittenCount: number;
  skippedCount: number;
  duplicatedCount: number;
}

interface ImportedToolboxFile {
  path: string;
  content: string;
}

export function createToolboxExportPayload(features: NormalizedFeatureDef[], prefs: Prefs): ToolboxExportPayload {
  const featureIds = features.map((feature) => feature.id);
  return {
    app: 'agentbox',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    features: features.map(stripFeatureForExport),
    prefs: {
      favorites: prefs.favorites.filter((id) => featureIds.includes(id)),
      order: prefs.order.filter((id) => featureIds.includes(id)),
    },
  };
}

export function exportToolboxConfig(defaultName: string, payload: ToolboxExportPayload): Promise<string | null> {
  return invoke<string | null>('export_toolbox_config', {
    defaultName,
    content: `${JSON.stringify(payload, null, 2)}\n`,
  });
}

export async function chooseToolboxImportFile(existingFeatures: NormalizedFeatureDef[]): Promise<ToolboxImportPreview | null> {
  const file = await invoke<ImportedToolboxFile | null>('choose_toolbox_import_file');
  if (!file) {
    return null;
  }
  return parseToolboxImportFile(file.path, file.content, existingFeatures);
}

export function parseToolboxImportFile(path: string, content: string, existingFeatures: NormalizedFeatureDef[]): ToolboxImportPreview {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error('导入文件不是有效 JSON');
  }
  const payload = normalizePayload(raw);
  const normalized = payload.features.map(normalizeFeature).filter((feature) => !feature.builtin && feature.name.trim());
  const invalidCount = payload.features.length - normalized.length;
  const existingNames = new Set(existingFeatures.map((feature) => feature.name.trim().toLowerCase()).filter(Boolean));
  const conflicted = normalized.filter((feature) => existingNames.has(feature.name.trim().toLowerCase()));
  const added = normalized.filter((feature) => !existingNames.has(feature.name.trim().toLowerCase()));
  return { path, payload: { ...payload, features: normalized.map(stripFeatureForExport) }, features: normalized, added, conflicted, invalidCount };
}

export function applyToolboxImport(
  preview: ToolboxImportPreview,
  existingFeatures: NormalizedFeatureDef[],
  prefs: Prefs,
  strategy: ToolboxImportConflictStrategy,
): ToolboxImportResult {
  const existingByName = new Map(existingFeatures.map((feature) => [feature.name.trim().toLowerCase(), feature]));
  const importedIds = new Map<string, string>();
  const nextFeatures = [...existingFeatures];
  let addedCount = 0;
  let overwrittenCount = 0;
  let skippedCount = 0;
  let duplicatedCount = 0;

  for (const feature of preview.features) {
    const key = feature.name.trim().toLowerCase();
    const existing = existingByName.get(key);
    if (existing) {
      if (strategy === 'skip') {
        importedIds.set(feature.id, existing.id);
        skippedCount += 1;
        continue;
      }
      if (strategy === 'overwrite') {
        const replacement = normalizeFeature({ ...stripFeatureForExport(feature), id: existing.id, builtin: false });
        const index = nextFeatures.findIndex((item) => item.id === existing.id);
        if (index >= 0) {
          nextFeatures[index] = replacement;
        }
        importedIds.set(feature.id, existing.id);
        overwrittenCount += 1;
        continue;
      }
      const duplicated = normalizeFeature({
        ...stripFeatureForExport(feature),
        id: uniqueFeatureId(feature.id, nextFeatures),
        name: uniqueFeatureName(`${feature.name} 导入`, nextFeatures),
        builtin: false,
      });
      nextFeatures.push(duplicated);
      importedIds.set(feature.id, duplicated.id);
      duplicatedCount += 1;
      continue;
    }
    const created = normalizeFeature({
      ...stripFeatureForExport(feature),
      id: uniqueFeatureId(feature.id, nextFeatures),
      builtin: false,
    });
    nextFeatures.push(created);
    importedIds.set(feature.id, created.id);
    existingByName.set(created.name.trim().toLowerCase(), created);
    addedCount += 1;
  }

  const importedPrefs = preview.payload.prefs ?? {};
  const nextOrder = mergeOrder(prefs.order, importedPrefs.order ?? [], importedIds, nextFeatures);
  const nextFavorites = mergeFavorites(prefs.favorites, importedPrefs.favorites ?? [], importedIds);
  return {
    features: nextFeatures,
    prefs: { favorites: nextFavorites, order: nextOrder },
    addedCount,
    overwrittenCount,
    skippedCount,
    duplicatedCount,
  };
}

function normalizePayload(raw: unknown): ToolboxExportPayload {
  if (!raw || typeof raw !== 'object') {
    throw new Error('导入文件格式不正确');
  }
  const value = raw as Partial<ToolboxExportPayload>;
  if (value.app !== 'agentbox' || value.schemaVersion !== 1 || !Array.isArray(value.features)) {
    throw new Error('导入文件不是 AgentBox 工具配置，或版本暂不支持');
  }
  return {
    app: 'agentbox',
    schemaVersion: 1,
    exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : '',
    features: value.features.filter(isFeatureLike).map((feature) => ({ ...feature, builtin: false })),
    prefs: value.prefs && typeof value.prefs === 'object' ? value.prefs : undefined,
  };
}

function isFeatureLike(value: unknown): value is FeatureDef {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const feature = value as Partial<FeatureDef>;
  return typeof feature.id === 'string' && typeof feature.name === 'string';
}

function stripFeatureForExport(feature: NormalizedFeatureDef): FeatureDef {
  return {
    id: feature.id,
    name: feature.name,
    description: feature.description,
    script: feature.script,
    extra: feature.extra,
    builtin: false,
    type: feature.type,
    agent: feature.agent,
    autoRun: feature.autoRun,
    seqRule: feature.seqRule,
    seqTerm: feature.seqTerm,
  };
}

function uniqueFeatureId(baseId: string, features: NormalizedFeatureDef[]): string {
  const ids = new Set(features.map((feature) => feature.id));
  const cleanBase = baseId.trim() || `imported-${Date.now()}`;
  if (!ids.has(cleanBase)) {
    return cleanBase;
  }
  let index = 2;
  while (ids.has(`${cleanBase}-${index}`)) {
    index += 1;
  }
  return `${cleanBase}-${index}`;
}

function uniqueFeatureName(baseName: string, features: NormalizedFeatureDef[]): string {
  const names = new Set(features.map((feature) => feature.name.trim().toLowerCase()));
  if (!names.has(baseName.trim().toLowerCase())) {
    return baseName;
  }
  let index = 2;
  while (names.has(`${baseName} ${index}`.trim().toLowerCase())) {
    index += 1;
  }
  return `${baseName} ${index}`;
}

function mergeOrder(
  currentOrder: string[],
  importedOrder: string[],
  importedIds: Map<string, string>,
  features: NormalizedFeatureDef[],
): string[] {
  const featureIds = new Set(features.map((feature) => feature.id));
  const ordered = currentOrder.filter((id) => featureIds.has(id));
  for (const oldId of importedOrder) {
    const nextId = importedIds.get(oldId);
    if (nextId && !ordered.includes(nextId)) {
      ordered.push(nextId);
    }
  }
  for (const feature of features) {
    if (!ordered.includes(feature.id)) {
      ordered.push(feature.id);
    }
  }
  return ordered;
}

function mergeFavorites(currentFavorites: string[], importedFavorites: string[], importedIds: Map<string, string>): string[] {
  const favorites = [...currentFavorites];
  for (const oldId of importedFavorites) {
    const nextId = importedIds.get(oldId);
    if (nextId && !favorites.includes(nextId)) {
      favorites.push(nextId);
    }
  }
  return favorites;
}
