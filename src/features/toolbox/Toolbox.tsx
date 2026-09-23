import { Plus, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { FeatureType, NormalizedFeatureDef, Prefs } from '../../shared/types';
import { FeatureItemMenu, FeatureMenuTrigger } from './FeatureItemMenu';

type SourceFilter = 'favorite' | 'all' | 'builtin' | 'custom';
type TypeFilter = 'all' | FeatureType;

interface ToolboxProps {
  features: NormalizedFeatureDef[];
  prefs: Prefs;
  onPrefsChange: (prefs: Prefs) => void;
  onInvoke: (feature: NormalizedFeatureDef) => void;
  onCreate: () => void;
  onEdit: (feature: NormalizedFeatureDef) => void;
  onDelete: (feature: NormalizedFeatureDef) => void;
  onTransfer?: (filteredFeatures: NormalizedFeatureDef[]) => void;
}

const SOURCE_FILTERS: Array<{ value: SourceFilter; label: string }> = [
  { value: 'favorite', label: '常用' },
  { value: 'all', label: '全部' },
  { value: 'builtin', label: '内置' },
  { value: 'custom', label: '自增' },
];

const TYPE_FILTERS: Array<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: '全部类型' },
  { value: 'prompt', label: '提示词' },
  { value: 'agent', label: 'Agent' },
  { value: 'url', label: 'URL' },
  { value: 'snippet', label: '片段' },
  { value: 'sequence', label: '工作流' },
];

export function Toolbox({
  features,
  prefs,
  onPrefsChange,
  onInvoke,
  onCreate,
  onEdit,
  onDelete,
  onTransfer,
}: ToolboxProps) {
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [keyword, setKeyword] = useState('');
  const [menuFeature, setMenuFeature] = useState<{ feature: NormalizedFeatureDef; rect: DOMRect } | null>(null);

  const orderedFeatures = useMemo(() => orderFeatures(features, prefs.order), [features, prefs.order]);
  const visibleFeatures = orderedFeatures.filter((feature) => {
    if (sourceFilter === 'favorite' && !prefs.favorites.includes(feature.id)) {
      return false;
    }
    if (sourceFilter === 'builtin' && !feature.builtin) {
      return false;
    }
    if (sourceFilter === 'custom' && feature.builtin) {
      return false;
    }
    if (typeFilter !== 'all' && feature.type !== typeFilter) {
      return false;
    }
    const text = `${feature.name} ${feature.description}`.toLowerCase();
    return text.includes(keyword.trim().toLowerCase());
  });

  function toggleFavorite(feature: NormalizedFeatureDef) {
    const favorites = prefs.favorites.includes(feature.id)
      ? prefs.favorites.filter((id) => id !== feature.id)
      : [...prefs.favorites, feature.id];
    onPrefsChange({ ...prefs, favorites });
  }

  function pinFeature(feature: NormalizedFeatureDef) {
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

  return (
    <section className="toolbox">
      <div className="toolbar">
        <div className="segmented" aria-label="来源筛选">
          {SOURCE_FILTERS.map((filter) => (
            <button
              className={filter.value === sourceFilter ? 'active' : ''}
              key={filter.value}
              onClick={() => setSourceFilter(filter.value)}
              type="button"
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="toolbar-actions">
          <button className="icon-button" onClick={() => onTransfer?.(visibleFeatures)} title="导入/导出" type="button">
            <Upload size={16} />
          </button>
          <button className="primary-button" onClick={onCreate} type="button">
            <Plus size={16} />
            功能
          </button>
        </div>
      </div>

      <div className="search-row">
        <input
          aria-label="搜索功能"
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索功能"
          type="search"
          value={keyword}
        />
        <select
          aria-label="类型筛选"
          onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}
          value={typeFilter}
        >
          {TYPE_FILTERS.map((filter) => (
            <option key={filter.value} value={filter.value}>
              {filter.label}
            </option>
          ))}
        </select>
      </div>

      <div className="feature-list">
        {visibleFeatures.length === 0 ? (
          <p className="empty">没有匹配的功能</p>
        ) : (
          visibleFeatures.map((feature) => (
            <article className="feature-card" key={feature.id}>
              <button className="feature-hit" onClick={() => onInvoke(feature)} type="button">
                <span className={`type-badge ${feature.builtin ? 'type-builtin' : `type-${feature.type}`}`}>{feature.builtin ? '内置' : typeLabel(feature.type)}</span>
                <strong>{feature.name}</strong>
                <span>{feature.description}</span>
              </button>
              <div className="feature-actions">
                <FeatureMenuTrigger label={`${feature.name} 功能操作`} onOpen={(rect) => setMenuFeature({ feature, rect })} />
              </div>
            </article>
          ))
        )}
      </div>

      {menuFeature && (
        <FeatureItemMenu
          anchorRect={menuFeature.rect}
          builtin={menuFeature.feature.builtin}
          favorite={prefs.favorites.includes(menuFeature.feature.id)}
          onClose={() => setMenuFeature(null)}
          onDelete={() => onDelete(menuFeature.feature)}
          onEdit={() => onEdit(menuFeature.feature)}
          onInvoke={() => onInvoke(menuFeature.feature)}
          onPin={() => pinFeature(menuFeature.feature)}
          onToggleFavorite={() => toggleFavorite(menuFeature.feature)}
        />
      )}
    </section>
  );
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
