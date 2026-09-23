import { GripVertical, Search, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { splitSequenceSteps } from '../../shared/featureModel';
import type { FeatureType, NormalizedFeatureDef, Prefs } from '../../shared/types';
import { FeatureItemMenu, FeatureMenuTrigger } from '../toolbox/FeatureItemMenu';

type SourceFilter = 'favorite' | 'all' | 'builtin' | 'custom';
type ToolFilterMode = SourceFilter | FeatureType;

interface AiToolPanelProps {
  detachedFeatureIds?: string[];
  features: NormalizedFeatureDef[];
  onCollapse: () => void;
  onDetach?: (feature: NormalizedFeatureDef, startDragging?: boolean) => void;
  onDelete?: (feature: NormalizedFeatureDef) => void;
  onEdit?: (feature: NormalizedFeatureDef) => void;
  onInvoke: (feature: NormalizedFeatureDef) => void;
  onPrefsChange?: (prefs: Prefs) => void;
  prefs: Prefs;
}

interface PendingPluginDrag {
  active: boolean;
  featureId: string;
  pointerId: number;
  startX: number;
  startY: number;
  lastTargetId: string | null;
  nativeDetachStarted?: boolean;
}

const TYPE_FILTERS: Array<{ value: FeatureType; label: string }> = [
  { value: 'prompt', label: '提示词' },
  { value: 'agent', label: 'Agent' },
  { value: 'snippet', label: '片段' },
  { value: 'sequence', label: '工作流' },
  { value: 'url', label: 'URL' },
];

const SOURCE_FILTERS: Array<{ value: SourceFilter; label: string }> = [
  { value: 'favorite', label: '常用' },
  { value: 'all', label: '全部' },
  { value: 'builtin', label: '内置' },
  { value: 'custom', label: '自增' },
];

export function AiToolPanel({ detachedFeatureIds = [], features, onCollapse, onDelete, onDetach, onEdit, onInvoke, onPrefsChange, prefs }: AiToolPanelProps) {
  const [keyword, setKeyword] = useState('');
  const [filterMode, setFilterMode] = useState<ToolFilterMode>('all');
  const [menuFeature, setMenuFeature] = useState<{ featureId: string; rect: DOMRect } | null>(null);
  const [draggingFeatureId, setDraggingFeatureId] = useState<string | null>(null);
  const [dropTargetFeatureId, setDropTargetFeatureId] = useState<string | null>(null);
  const suppressInvokeRef = useRef(false);
  const pendingDragRef = useRef<PendingPluginDrag | null>(null);
  const detachInProgressRef = useRef(false);
  const panelRef = useRef<HTMLElement | null>(null);

  const orderedFeatures = useMemo(() => orderFeatures(features, prefs.order), [features, prefs.order]);
  const selectedMenuFeature = menuFeature
    ? orderedFeatures.find((feature) => feature.id === menuFeature.featureId) ?? null
    : null;

  const visibleFeatures = orderedFeatures.filter((feature) => {
    if (detachedFeatureIds.includes(feature.id)) {
      return false;
    }
    if (filterMode === 'favorite' && !prefs.favorites.includes(feature.id)) {
      return false;
    }
    if (filterMode === 'builtin' && !feature.builtin) {
      return false;
    }
    if (filterMode === 'custom' && feature.builtin) {
      return false;
    }
    if (isFeatureTypeFilter(filterMode) && feature.type !== filterMode) {
      return false;
    }
    const text = `${feature.name} ${feature.description}`.toLowerCase();
    return text.includes(keyword.trim().toLowerCase());
  });

  useEffect(() => {
    if (menuFeature && !selectedMenuFeature) {
      setMenuFeature(null);
    }
  }, [menuFeature, selectedMenuFeature]);

  function toggleFavorite(feature: NormalizedFeatureDef) {
    if (!onPrefsChange) {
      return;
    }
    const favorites = prefs.favorites.includes(feature.id)
      ? prefs.favorites.filter((id) => id !== feature.id)
      : [...prefs.favorites, feature.id];
    onPrefsChange({ ...prefs, favorites });
  }

  function pinFeature(feature: NormalizedFeatureDef) {
    if (!onPrefsChange) {
      return;
    }
    const ids = orderedFeatures.map((item) => item.id);
    const visibleIds = visibleFeatures.map((item) => item.id).filter((id) => id !== feature.id);
    const firstVisibleIndex = ids.findIndex((id) => visibleIds.includes(id));
    if (firstVisibleIndex < 0) {
      return;
    }
    const next = ids.filter((id) => id !== feature.id);
    next.splice(firstVisibleIndex, 0, feature.id);
    onPrefsChange({ ...prefs, order: next });
  }

  function beginPluginDrag(feature: NormalizedFeatureDef, event: React.PointerEvent<HTMLElement>) {
    if (pendingDragRef.current || (typeof event.button === 'number' && event.button !== 0)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    detachInProgressRef.current = false;
    if (typeof event.pointerId === 'number') {
      try {
        panelRef.current?.setPointerCapture(event.pointerId);
      } catch {
        // Tauri WebView 旧版本可能不支持面板级 pointer capture，全局监听仍可完成拖动。
      }
    }
    pendingDragRef.current = {
      active: false,
      featureId: feature.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastTargetId: null,
    };
  }

  function handlePluginDragMove(event: PointerEvent) {
    const pending = pendingDragRef.current;
    if (!pending || (pending.pointerId >= 0 && typeof event.pointerId === 'number' && event.pointerId !== 0 && pending.pointerId !== event.pointerId)) {
      return;
    }
    if (!pending.active) {
      const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
      if (distance < 6) {
        return;
      }
      pending.active = true;
      setDraggingFeatureId(pending.featureId);
    }

    const panelRect = panelRef.current?.getBoundingClientRect();
    const outsidePanel = panelRect
      ? event.clientX < panelRect.left || event.clientX > panelRect.right || event.clientY < panelRect.top || event.clientY > panelRect.bottom
      : false;
    if (outsidePanel && !detachInProgressRef.current) {
      const feature = features.find((item) => item.id === pending.featureId);
      detachInProgressRef.current = true;
      setDraggingFeatureId(null);
      setDropTargetFeatureId(null);
      pending.nativeDetachStarted = true;
      if (feature) {
        onDetach?.(feature, true);
      }
      return;
    }

    const hit = document.elementFromPoint?.(event.clientX, event.clientY) ?? event.target;
    const target = hit instanceof HTMLElement ? hit.closest<HTMLElement>('[data-feature-id]') : null;
    const targetId = target?.dataset.featureId ?? null;
    if (!targetId || targetId === pending.featureId) {
      setDropTargetFeatureId(null);
      return;
    }
    if (pending.lastTargetId === targetId) {
      return;
    }
    pending.lastTargetId = targetId;
    setDropTargetFeatureId(targetId);
  }

  function handlePluginDragEnd(event: PointerEvent, detachWhenOutside = true) {
    const pending = pendingDragRef.current;
    if (!pending || (pending.pointerId >= 0 && typeof event.pointerId === 'number' && event.pointerId !== 0 && pending.pointerId !== event.pointerId)) {
      return;
    }
    pendingDragRef.current = null;
    detachInProgressRef.current = false;
    setDraggingFeatureId(null);
    setDropTargetFeatureId(null);
    if (pending.nativeDetachStarted) {
      void invoke('stop_plugin_window_follow', { pluginId: pending.featureId });
      return;
    }
    try {
      panelRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture 可能已由系统释放。
    }
    if (!pending.active) {
      return;
    }
    suppressInvokeRef.current = true;
    window.setTimeout(() => {
      suppressInvokeRef.current = false;
    }, 0);
    const rect = panelRef.current?.getBoundingClientRect();
    const outside = rect
      ? event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom
      : true;
    if (outside && detachWhenOutside) {
      const feature = features.find((item) => item.id === pending.featureId);
      if (feature) {
        onDetach?.(feature, true);
      }
      return;
    }
    if (pending.lastTargetId && onPrefsChange) {
      const ids = orderedFeatures.map((item) => item.id);
      const sourceIndex = ids.indexOf(pending.featureId);
      const targetIndex = ids.indexOf(pending.lastTargetId);
      if (sourceIndex >= 0 && targetIndex >= 0) {
        ids.splice(sourceIndex, 1);
        ids.splice(targetIndex, 0, pending.featureId);
        onPrefsChange({ ...prefs, order: ids });
      }
    }
  }

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => handlePluginDragMove(event);
    const onPointerUp = (event: PointerEvent) => handlePluginDragEnd(event);
    const onPointerCancel = (event: PointerEvent) => handlePluginDragEnd(event, false);
    const onWindowBlur = () => {
      const pending = pendingDragRef.current;
      if (!pending || !pending.active) {
        pendingDragRef.current = null;
        setDraggingFeatureId(null);
        setDropTargetFeatureId(null);
        return;
      }
      const feature = features.find((item) => item.id === pending.featureId);
      pendingDragRef.current = null;
      setDraggingFeatureId(null);
      setDropTargetFeatureId(null);
      if (pending.nativeDetachStarted) {
        // 独立窗口获得焦点会让主窗口失焦；释放状态由 macOS 原生线程检测。
        return;
      }
      suppressInvokeRef.current = true;
      window.setTimeout(() => {
        suppressInvokeRef.current = false;
      }, 0);
      if (feature) {
        onDetach?.(feature);
      }
    };
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerCancel, true);
      window.removeEventListener('blur', onWindowBlur);
    };
  });

  return (
    <aside className="ai-tool-panel" ref={panelRef}>
      <header className="ai-tool-header">
        <strong>工具列表</strong>
        <button aria-label="收起工具" className="icon-button" onClick={onCollapse} title="收起工具" type="button">
          <X size={16} />
        </button>
      </header>

      <div className="ai-tool-search">
        <Search size={15} />
        <input
          aria-label="搜索工具"
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索工具"
          type="search"
          value={keyword}
        />
      </div>

      <div className="segmented ai-tool-sources" aria-label="工具来源筛选">
        {SOURCE_FILTERS.map((filter) => (
          <button
            className={filter.value === filterMode ? 'active' : ''}
            key={filter.value}
            onClick={() => setFilterMode(filter.value)}
            type="button"
          >
            {filter.label}
          </button>
        ))}
      </div>

      <select
        aria-label="功能类型筛选"
        className="ai-tool-type-select"
        onChange={(event) => {
          const next = event.target.value;
          if (isFeatureTypeFilter(next)) {
            setFilterMode(next);
          }
        }}
        value={isFeatureTypeFilter(filterMode) ? filterMode : ''}
      >
        <option value="">功能类型</option>
        {TYPE_FILTERS.map((filter) => (
          <option key={filter.value} value={filter.value}>
            {filter.label}
          </option>
        ))}
      </select>

      <div aria-label="AI 工具列表" className="ai-tool-list natural-height-list">
        {visibleFeatures.length === 0 ? (
          <p className="empty">没有匹配的工具</p>
        ) : (
          visibleFeatures.map((feature) => (
            <article
              className={`${draggingFeatureId === feature.id ? 'feature-card dragging' : 'feature-card'}${dropTargetFeatureId === feature.id ? ' drop-target' : ''}`}
              data-feature-id={feature.id}
              key={feature.id}
            >
              <button
                aria-label={`拖动${feature.name}`}
                className="feature-drag-handle"
                onPointerDown={(event) => beginPluginDrag(feature, event)}
                title="拖动排序；拖出插件栏可脱离为独立窗口"
                type="button"
              >
                <GripVertical aria-hidden="true" size={16} />
              </button>
              <button
                className="feature-hit"
                onClick={() => {
                  if (!suppressInvokeRef.current) {
                    onInvoke(feature);
                  }
                }}
                type="button"
              >
                <span className={`type-badge ${feature.builtin ? 'type-builtin' : `type-${feature.type}`}`}>{feature.builtin ? '内置' : typeLabel(feature.type)}</span>
                <strong>{feature.name}</strong>
                <span>{feature.description || '暂无简介'}</span>
              </button>
              <div className="feature-actions">
                <FeatureMenuTrigger label={`${feature.name} 功能操作`} onOpen={(rect) => setMenuFeature({ featureId: feature.id, rect })} />
              </div>
            </article>
          ))
        )}
      </div>

      {menuFeature && selectedMenuFeature && (
        <FeatureItemMenu
          anchorRect={menuFeature.rect}
          builtin={selectedMenuFeature.builtin}
          favorite={prefs.favorites.includes(selectedMenuFeature.id)}
          onClose={() => setMenuFeature(null)}
          onDelete={onDelete ? () => onDelete(selectedMenuFeature) : undefined}
          onEdit={onEdit ? () => onEdit(selectedMenuFeature) : undefined}
          onInvoke={() => onInvoke(selectedMenuFeature)}
          onPin={() => pinFeature(selectedMenuFeature)}
          onToggleFavorite={() => toggleFavorite(selectedMenuFeature)}
        />
      )}
    </aside>
  );
}

export function featureToComposerText(feature: NormalizedFeatureDef): string {
  const script = (feature.script ?? '').trim();
  switch (feature.type) {
    case 'sequence':
      return splitSequenceSteps(script).join('\n');
    case 'url':
    case 'agent':
    case 'snippet':
    case 'prompt':
    default:
      return script;
  }
}

function orderFeatures(features: NormalizedFeatureDef[], order: string[]) {
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  const ordered = order.flatMap((id) => {
    const feature = byId.get(id);
    return feature ? [feature] : [];
  });
  const missing = features.filter((feature) => !order.includes(feature.id));
  return [...ordered, ...missing];
}

function typeLabel(type: FeatureType): string {
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

function isFeatureTypeFilter(value: string): value is FeatureType {
  return value === 'prompt' || value === 'agent' || value === 'snippet' || value === 'sequence' || value === 'url';
}
