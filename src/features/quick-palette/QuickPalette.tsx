import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ArrowLeft, Check, ChevronDown, GripHorizontal, Search, Settings2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { JsonFormatter } from '../json/JsonFormatter';
import { PromptPad } from '../promptpad/PromptPad';
import { buildFeatureAction, runFeatureAction } from '../runner/featureRunner';
import { builtinFeatures, normalizeFeature, splitSequenceSteps } from '../../shared/featureModel';
import { loadCustomFeatures, loadPrefs, savePrefs } from '../../shared/promptpadStorage';
import type { FeatureType, NormalizedFeatureDef, Prefs } from '../../shared/types';
import { normalizeQuickPalettePrefs, visiblePaletteFeatures, type PaletteFilter } from './quickPaletteModel';

const SHORTCUTS = ['Control+Option+Space', 'Control+Shift+Space', 'Command+Shift+Space'];
const TYPE_OPTIONS: Array<{ value: 'all' | FeatureType; label: string }> = [
  { value: 'all', label: '全部类型' },
  { value: 'prompt', label: '提示词' },
  { value: 'snippet', label: '片段' },
  { value: 'agent', label: 'Agent' },
  { value: 'sequence', label: '工作流' },
  { value: 'url', label: 'URL' },
];

export function QuickPalette() {
  const [features, setFeatures] = useState<NormalizedFeatureDef[]>([]);
  const [prefs, setPrefs] = useState<Prefs>(() => normalizeQuickPalettePrefs({ favorites: [], order: [] }));
  // 快捷浮窗首次打开应展示导入的全部工具；“常用”仍可由用户主动筛选。
  const [filter, setFilter] = useState<PaletteFilter>({ keyword: '', source: 'all', type: 'all' });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [message, setMessage] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [activeWorkflow, setActiveWorkflow] = useState<NormalizedFeatureDef | null>(null);
  const [workflowDone, setWorkflowDone] = useState<Record<string, Record<number, boolean>>>({});
  const searchRef = useRef<HTMLInputElement | null>(null);
  const typeMenuRef = useRef<HTMLDivElement | null>(null);

  const ordered = useMemo(() => {
    const order = new Map(prefs.order.map((id, index) => [id, index]));
    return [...features].sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }, [features, prefs.order]);
  const visible = useMemo(() => visiblePaletteFeatures(ordered, filter, prefs.favorites), [filter, ordered, prefs.favorites]);

  useEffect(() => {
    void reload();
    const refreshOnOpen = () => {
      setFilter((current) => ({ ...current, keyword: '' }));
      setSelectedIndex(0);
      setMessage('');
      setTypeMenuOpen(false);
      void reload().then(() => searchRef.current?.focus());
      // 浮窗在主窗口导入配置的同时可能错过首次事件，补一次异步刷新兜底。
      window.setTimeout(() => void reload(), 80);
    };
    const unlisten = listen('quick-palette-open', refreshOnOpen);
    const refreshOnFocus = () => void reload();
    const refreshOnVisibility = () => {
      if (document.visibilityState === 'visible') {
        refreshOnFocus();
      }
    };
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnVisibility);
    return () => {
      void unlisten.then((dispose) => dispose());
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnVisibility);
    };
  }, []);

  useEffect(() => {
    if (!typeMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!typeMenuRef.current?.contains(event.target as Node)) setTypeMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [typeMenuOpen]);

  useEffect(() => {
    if (selectedIndex >= visible.length) setSelectedIndex(Math.max(0, visible.length - 1));
  }, [selectedIndex, visible.length]);

  async function reload() {
    const [custom, storedPrefs] = await Promise.all([loadCustomFeatures(), loadPrefs()]);
    setFeatures([...builtinFeatures(), ...custom.map(normalizeFeature)]);
    setPrefs(normalizeQuickPalettePrefs(storedPrefs));
  }

  async function persistPrefs(next: Prefs) {
    const normalized = normalizeQuickPalettePrefs(next);
    setPrefs(normalized);
    await savePrefs(normalized);
  }

  async function copyToClipboard(text: string) {
    try {
      await invoke('set_clipboard_text', { text });
      setMessage('复制成功，可到目标位置粘贴');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(`复制失败：${detail}`);
    }
  }

  async function execute(feature: NormalizedFeatureDef) {
    if (feature.type === 'sequence') {
      setActiveWorkflow(feature);
      setMessage('');
      return;
    }
    const action = buildFeatureAction(feature);
    if (action.kind === 'promptpad') {
      setPromptOpen(true);
      return;
    }
    if (action.kind === 'json-format') {
      setJsonOpen(true);
      return;
    }
    if (action.kind === 'paste') {
      await copyToClipboard(action.text);
      return;
    }
    try {
      await runFeatureAction(action);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(visible.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter' && visible[selectedIndex]) {
      event.preventDefault();
      void execute(visible[selectedIndex]);
    }
  }

  async function changeShortcut(shortcut: string) {
    try {
      await invoke('set_global_shortcut', { shortcut });
      await persistPrefs({ ...prefs, globalShortcut: shortcut });
      setMessage('全局快捷键已更新');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function startDragging(event: MouseEvent<HTMLDivElement>) {
    if (event.button === 0) void invoke('start_quick_palette_drag');
  }

  function closeWorkflow() {
    setActiveWorkflow(null);
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  function toggleWorkflowStep(index: number) {
    if (!activeWorkflow) return;
    setWorkflowDone((current) => ({
      ...current,
      [activeWorkflow.id]: {
        ...current[activeWorkflow.id],
        [index]: !current[activeWorkflow.id]?.[index],
      },
    }));
  }

  return (
    <main className={activeWorkflow ? 'quick-palette-shell workflow-mode' : 'quick-palette-shell'}>
      <div className="quick-palette-dragbar" onMouseDown={startDragging}>
        <span><GripHorizontal size={15} />{activeWorkflow ? '工作流' : '快捷工具'}</span>
        <button aria-label="关闭快捷面板" onClick={() => void invoke('hide_quick_palette')} onMouseDown={(event) => event.stopPropagation()} title="关闭" type="button"><X size={15} /></button>
      </div>
      {activeWorkflow ? (
        <>
          <header className="quick-workflow-header">
            <button aria-label="返回快捷工具列表" className="icon-button" onClick={closeWorkflow} title="返回" type="button"><ArrowLeft size={18} /></button>
            <div>
              <h2>{activeWorkflow.name}</h2>
              <p>{activeWorkflow.description}</p>
            </div>
            <span>{activeWorkflow.seqRule === 'confirm' ? '逐步确认' : '自动'}</span>
          </header>
          <section aria-label={`${activeWorkflow.name}步骤`} className="quick-workflow-steps">
            {activeWorkflow.seqRule === 'auto' && (
              <button className="quick-workflow-insert-all" onClick={() => void copyToClipboard(splitSequenceSteps(activeWorkflow.script).join('\n'))} type="button">
                复制全部步骤
              </button>
            )}
            {splitSequenceSteps(activeWorkflow.script).map((step, index) => {
              const done = workflowDone[activeWorkflow.id]?.[index] === true;
              return (
                <article className={done ? 'quick-workflow-step done' : 'quick-workflow-step'} key={`${activeWorkflow.id}-${index}`}>
                  <header><strong>步骤 {index + 1}</strong>{done && <span><Check size={13} />已完成</span>}</header>
                  <pre>{step}</pre>
                  <footer>
                    <button aria-label={`复制步骤 ${index + 1}`} className="primary-button" onClick={() => void copyToClipboard(step)} type="button">复制步骤</button>
                    <button onClick={() => toggleWorkflowStep(index)} type="button">{done ? '取消完成' : '标记完成'}</button>
                  </footer>
                </article>
              );
            })}
          </section>
        </>
      ) : (
        <>
          <header className="quick-palette-header">
        <label className="quick-palette-search">
          <Search size={18} />
          <input
            autoFocus
            onChange={(event) => { setFilter((current) => ({ ...current, keyword: event.target.value })); setSelectedIndex(0); }}
            onKeyDown={handleKeyDown}
            placeholder="搜索工具、提示词或片段"
            ref={searchRef}
            type="search"
            value={filter.keyword}
          />
        </label>
        <button aria-label="快捷面板设置" className="quick-palette-settings-button" onClick={() => setSettingsOpen((open) => !open)} title="设置" type="button"><Settings2 size={17} /></button>
        {settingsOpen && (
          <div className="quick-palette-settings">
            <label>全局快捷键<select aria-label="全局快捷键" onChange={(event) => void changeShortcut(event.target.value)} value={prefs.globalShortcut}>{SHORTCUTS.map((shortcut) => <option key={shortcut} value={shortcut}>{shortcut}</option>)}</select></label>
          </div>
        )}
          </header>

          <div className="quick-palette-filters">
        <div className="segmented">
          <button className={filter.source === 'favorite' ? 'active' : ''} onClick={() => setFilter((current) => ({ ...current, source: 'favorite' }))} type="button">常用</button>
          <button className={filter.source === 'all' ? 'active' : ''} onClick={() => setFilter((current) => ({ ...current, source: 'all' }))} type="button">全部</button>
        </div>
        <div className="quick-palette-type-filter" ref={typeMenuRef}>
          <button
            aria-expanded={typeMenuOpen}
            aria-haspopup="listbox"
            aria-label={`功能类型：${TYPE_OPTIONS.find((option) => option.value === filter.type)?.label ?? '全部类型'}`}
            className={typeMenuOpen ? 'quick-palette-type-trigger open' : 'quick-palette-type-trigger'}
            onClick={() => setTypeMenuOpen((open) => !open)}
            type="button"
          >
            <span>{TYPE_OPTIONS.find((option) => option.value === filter.type)?.label ?? '全部类型'}</span>
            <ChevronDown size={15} />
          </button>
          {typeMenuOpen && (
            <div aria-label="功能类型" className="quick-palette-type-menu" role="listbox">
              {TYPE_OPTIONS.map((option) => (
                <button
                  aria-selected={filter.type === option.value}
                  className={filter.type === option.value ? 'selected' : ''}
                  key={option.value}
                  onClick={() => {
                    setFilter((current) => ({ ...current, type: option.value }));
                    setSelectedIndex(0);
                    setTypeMenuOpen(false);
                  }}
                  role="option"
                  type="button"
                >
                  <span>{option.label}</span>
                  {filter.type === option.value && <Check size={14} />}
                </button>
              ))}
            </div>
          )}
        </div>
          </div>

          <section aria-label="快捷工具列表" className="quick-palette-results">
        {visible.length ? visible.map((feature, index) => (
          <button aria-label={`${feature.name} ${feature.description}`} className={index === selectedIndex ? 'quick-palette-item active' : 'quick-palette-item'} key={feature.id} onMouseEnter={() => setSelectedIndex(index)} onClick={() => void execute(feature)} type="button">
            <span className={`type-badge ${feature.builtin ? 'type-builtin' : `type-${feature.type}`}`}>{feature.builtin ? '内置' : feature.type === 'snippet' ? '片段' : feature.type === 'prompt' ? '提示词' : feature.type === 'sequence' ? '工作流' : feature.type}</span>
            <span className="quick-palette-item-copy"><strong>{feature.name}</strong><small>{feature.description}</small></span>
          </button>
        )) : <p className="empty">没有匹配的工具</p>}
          </section>
        </>
      )}

      <footer className="quick-palette-footer">
        <span>{message || '点击复制 · ↑↓ 选择 · Enter 执行 · 关闭按钮退出'}</span>
      </footer>

      {promptOpen && <PromptPad snippets={features.filter((feature) => feature.type === 'snippet')} onClose={() => setPromptOpen(false)} onSubmit={copyToClipboard} submitMode="copy" />}
      {jsonOpen && <JsonFormatter onClose={() => setJsonOpen(false)} onCopy={async (text) => { await copyToClipboard(text); setJsonOpen(false); }} />}
    </main>
  );
}
