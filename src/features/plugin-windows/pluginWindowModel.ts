export type PluginDropAction = 'reorder' | 'detach' | 'cancel';

export interface PluginDropContext {
  insidePanel: boolean;
  movedOutside: boolean;
  hasSource: boolean;
}

export interface PluginWindowState {
  featureId: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  maximized?: boolean;
}

const WINDOW_LABEL_PREFIX = 'plugin-';
const MIN_WINDOW_WIDTH = 420;
const MIN_WINDOW_HEIGHT = 320;

export function classifyPluginDrop(context: PluginDropContext): PluginDropAction {
  if (!context.hasSource) {
    return 'cancel';
  }
  if (context.insidePanel) {
    return 'reorder';
  }
  return context.movedOutside ? 'detach' : 'cancel';
}

export function pluginWindowLabel(featureId: string): string {
  const normalized = featureId.trim();
  if (!normalized) {
    throw new Error('插件 ID 不能为空');
  }
  return `${WINDOW_LABEL_PREFIX}${normalized.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

export function normalizePluginWindowState(state: PluginWindowState): PluginWindowState {
  return {
    featureId: state.featureId,
    x: finiteOrUndefined(state.x),
    y: finiteOrUndefined(state.y),
    width: Math.max(MIN_WINDOW_WIDTH, finiteOrDefault(state.width, MIN_WINDOW_WIDTH)),
    height: Math.max(MIN_WINDOW_HEIGHT, finiteOrDefault(state.height, MIN_WINDOW_HEIGHT)),
    maximized: state.maximized === true,
  };
}

export function serializePluginWindowState(state: PluginWindowState): string {
  return JSON.stringify(normalizePluginWindowState(state));
}

export function deserializePluginWindowState(raw: string): PluginWindowState | null {
  try {
    const value = JSON.parse(raw) as Partial<PluginWindowState>;
    if (typeof value.featureId !== 'string' || !value.featureId.trim()) {
      return null;
    }
    return normalizePluginWindowState({ ...value, featureId: value.featureId });
  } catch {
    return null;
  }
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return finiteOrUndefined(value) ?? fallback;
}
