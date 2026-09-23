import { describe, expect, it } from 'vitest';
import {
  classifyPluginDrop,
  deserializePluginWindowState,
  normalizePluginWindowState,
  pluginWindowLabel,
  serializePluginWindowState,
} from './pluginWindowModel';

describe('pluginWindowModel', () => {
  it('keeps an internal drag as reorder and an external drop as detach', () => {
    expect(classifyPluginDrop({ hasSource: true, insidePanel: true, movedOutside: false })).toBe('reorder');
    expect(classifyPluginDrop({ hasSource: true, insidePanel: false, movedOutside: true })).toBe('detach');
    expect(classifyPluginDrop({ hasSource: false, insidePanel: false, movedOutside: true })).toBe('cancel');
  });

  it('uses one stable safe label for one plugin', () => {
    expect(pluginWindowLabel('feature-123')).toBe('plugin-feature-123');
    expect(pluginWindowLabel('feature/123')).toBe('plugin-feature-123');
    expect(() => pluginWindowLabel('  ')).toThrow('插件 ID 不能为空');
  });

  it('normalizes geometry and rejects invalid serialized state', () => {
    const state = normalizePluginWindowState({ featureId: 'feature-1', width: 100, height: Number.NaN });
    expect(state.width).toBe(420);
    expect(state.height).toBe(320);
    expect(deserializePluginWindowState(serializePluginWindowState(state))).toEqual(state);
    expect(deserializePluginWindowState('{"featureId":""}')).toBeNull();
  });
});
