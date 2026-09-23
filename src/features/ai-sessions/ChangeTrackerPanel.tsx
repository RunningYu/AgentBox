import { FileSearch, FolderOpen, PanelLeftClose, PanelLeftOpen, Pause, Play, RefreshCw, RotateCcw, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { chooseDocumentDirectory, readContextFile, type DocumentFileContent } from './documentApi';
import { scanRecentChanges, type RecentChangedFile } from './changeTrackerApi';

interface ChangeTrackerPanelProps {
  cwd: string | null;
  onCollapse: () => void;
  onError: (message: string) => void;
  onInsertText: (text: string) => void;
}

const TRACK_INTERVAL_MS = 8_000;
const TRACKER_STATE_KEY = 'agentbox.change-tracker-state.v1';
const MAX_PERSISTED_TRACKED_FILES = 80;

interface TrackerState {
  rootPath: string | null;
  enabled: boolean;
  listCollapsed: boolean;
  changes: RecentChangedFile[];
  knownPaths: string[];
  selectedAbsolutePath: string | null;
  signature: string;
  trackerStartedAt: number;
}

interface TrackerPreferences {
  rootPath: string | null;
  enabled: boolean;
  listCollapsed: boolean;
}

type TrackerViewMode = 'content' | 'diff';

export type ChangeDiffRowKind = 'add' | 'context' | 'del';

export interface ChangeDiffRow {
  kind: ChangeDiffRowKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

interface ChangeDiff {
  added: number;
  deleted: number;
  firstChangedLine: number | null;
  rows: ChangeDiffRow[];
}

const runtimeTrackerState = {
  changes: [] as RecentChangedFile[],
  diffByPath: new Map<string, ChangeDiff>(),
  knownPaths: new Set<string>(),
  previousContent: new Map<string, string>(),
  selectedAbsolutePath: null as string | null,
  signature: '',
  trackerStartedAt: Date.now(),
};

export function resetChangeTrackerRuntimeStateForTests() {
  resetRuntimeTrackerState();
}

export function ChangeTrackerPanel({ cwd, onCollapse, onError, onInsertText }: ChangeTrackerPanelProps) {
  const initialTrackerStateRef = useRef<TrackerState | null>(null);
  if (initialTrackerStateRef.current === null) {
    initialTrackerStateRef.current = loadTrackerState();
  }
  const initialTrackerState = initialTrackerStateRef.current;
  const [rootPath, setRootPath] = useState<string | null>(() => initialTrackerState.rootPath);
  const [enabled, setEnabled] = useState(() => initialTrackerState.enabled);
  const [listCollapsed, setListCollapsed] = useState(() => initialTrackerState.listCollapsed);
  const [changes, setChanges] = useState<RecentChangedFile[]>(() => initialTrackerState.changes);
  const [selected, setSelected] = useState<DocumentFileContent | null>(null);
  const [selectedAbsolutePath, setSelectedAbsolutePath] = useState<string | null>(() => initialTrackerState.selectedAbsolutePath);
  const [changedLine, setChangedLine] = useState<number | null>(null);
  const [diff, setDiff] = useState<ChangeDiff | null>(null);
  const [viewMode, setViewMode] = useState<TrackerViewMode>('diff');
  const [autoSwitching, setAutoSwitching] = useState(false);
  const [loading, setLoading] = useState(false);
  const previousContentRef = useRef<Map<string, string>>(runtimeTrackerState.previousContent);
  const diffByPathRef = useRef<Map<string, ChangeDiff>>(runtimeTrackerState.diffByPath);
  const knownPathsRef = useRef<Set<string>>(new Set(initialTrackerState.knownPaths));
  const signatureRef = useRef(initialTrackerState.signature);
  const contentRef = useRef<HTMLPreElement | null>(null);
  const diffRef = useRef<HTMLPreElement | null>(null);
  const refreshInFlightRef = useRef(false);
  const pendingAutoRefreshRef = useRef(false);
  const trackerStartedAtRef = useRef(initialTrackerState.trackerStartedAt || Date.now());

  const effectiveRoot = rootPath || cwd;
  const lines = useMemo(() => selected?.content.split('\n') ?? [], [selected]);
  const firstDiffRowIndex = useMemo(() => diff?.rows.findIndex((row) => row.kind !== 'context') ?? -1, [diff]);

  useEffect(() => {
    if (!rootPath && cwd) {
      setRootPath(cwd);
    }
  }, [cwd, rootPath]);

  useEffect(() => {
    saveTrackerStateSnapshot();
  }, [enabled, listCollapsed, rootPath, selectedAbsolutePath]);

  useEffect(() => {
    if (!effectiveRoot) {
      return;
    }
    void refreshChanges('manual');
  }, [effectiveRoot]);

  useEffect(() => {
    if (!selectedAbsolutePath || selected?.path === selectedAbsolutePath) {
      return;
    }
    const file = changes.find((item) => item.absolutePath === selectedAbsolutePath);
    if (file) {
      void openChangedFile(file, false);
    }
  }, [changes, selected?.path, selectedAbsolutePath]);

  useEffect(() => {
    if (!effectiveRoot || !enabled) {
      return;
    }
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        void refreshChanges('auto');
      }
    }, TRACK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [effectiveRoot, enabled]);

  useEffect(() => {
    if (changedLine === null) {
      return;
    }
    const target = contentRef.current?.querySelector(`[data-line="${changedLine}"]`);
    scrollIntoViewIfPossible(target);
  }, [changedLine, selected?.path]);

  useEffect(() => {
    if (viewMode !== 'diff' || !diff?.firstChangedLine) {
      return;
    }
    const target = diffRef.current?.querySelector('[data-first-change="true"]');
    scrollIntoViewIfPossible(target);
  }, [diff, viewMode]);

  async function refreshChanges(source: 'manual' | 'auto') {
    if (!effectiveRoot) {
      return;
    }
    if (refreshInFlightRef.current) {
      if (source === 'auto') {
        pendingAutoRefreshRef.current = true;
      }
      return;
    }
    try {
      refreshInFlightRef.current = true;
      if (source === 'manual') {
        setLoading(true);
      }
      const next = await scanRecentChanges(effectiveRoot, source === 'auto' ? 40 : 80);
      const signature = fileSignature(next);
      const previous = signatureRef.current;
      const changed = previous !== signature;
      const initialized = previous !== '';
      const knownBefore = knownPathsRef.current;
      const newlyDiscovered = initialized
        ? next.filter((file) => !knownBefore.has(file.absolutePath))
        : [];
      next.forEach((file) => knownPathsRef.current.add(file.absolutePath));
      signatureRef.current = signature;
      if (!initialized) {
        await seedBaselines(next);
      } else if (newlyDiscovered.length > 0) {
        await seedBaselines(newlyDiscovered);
      }
      if (changed || source === 'manual') {
        pruneMissingChangedFiles(next);
      }
      if (initialized && changed) {
        await captureChangedFileDiffs(next.slice(1));
      }
      if (!initialized && source === 'manual' && next[0]) {
        await openChangedFile(next[0], false);
        return;
      }
      if (initialized && changed && next[0]) {
        await openChangedFile(next[0], source === 'auto');
      }
      if (source === 'manual' && !selected && !changed && next[0]) {
        await openChangedFile(next[0], false);
      }
      saveTrackerStateSnapshot();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      refreshInFlightRef.current = false;
      if (source === 'manual') {
        setLoading(false);
      }
      if (pendingAutoRefreshRef.current && enabled) {
        pendingAutoRefreshRef.current = false;
        void refreshChanges('auto');
      }
    }
  }

  async function chooseRoot() {
    try {
      const path = await chooseDocumentDirectory();
      if (!path) {
        return;
      }
      setRootPath(path);
      setSelected(null);
      setSelectedAbsolutePath(null);
      setChangedLine(null);
      setDiff(null);
      setViewMode('diff');
      previousContentRef.current.clear();
      diffByPathRef.current.clear();
      knownPathsRef.current.clear();
      signatureRef.current = '';
      trackerStartedAtRef.current = Date.now();
      setChanges([]);
      saveTrackerStateSnapshot([]);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function resetTrackingBaseline() {
    if (!effectiveRoot) {
      return;
    }
    try {
      setLoading(true);
      const next = await scanRecentChanges(effectiveRoot, 80);
      previousContentRef.current.clear();
      diffByPathRef.current.clear();
      knownPathsRef.current = new Set(next.map((file) => file.absolutePath));
      signatureRef.current = fileSignature(next);
      trackerStartedAtRef.current = Date.now();
      setChanges([]);
      setSelected(null);
      setSelectedAbsolutePath(null);
      setChangedLine(null);
      setDiff(null);
      setViewMode('diff');
      await seedBaselines(next, true);
      saveTrackerStateSnapshot([]);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function openChangedFile(file: RecentChangedFile, auto: boolean) {
    try {
      const previous = previousContentRef.current.get(file.absolutePath) ?? null;
      const cachedDiff = diffByPathRef.current.get(file.absolutePath) ?? null;
      const content = await readContextFile(file.absolutePath);
      const baseline = previous;
      const hasBaseline = baseline !== null;
      const contentChanged = hasBaseline && baseline !== content.content;
      const calculatedDiff = hasBaseline
        ? (contentChanged ? buildLineDiff(baseline, content.content) : null)
        : null;
      const nextDiff = calculatedDiff?.rows.length ? calculatedDiff : cachedDiff;
      if (calculatedDiff?.rows.length) {
        diffByPathRef.current.set(file.absolutePath, calculatedDiff);
        upsertChangedFile(file);
      } else if (contentChanged) {
        diffByPathRef.current.delete(file.absolutePath);
        removeChangedFile(file.absolutePath);
      } else if (!hasBaseline) {
        previousContentRef.current.set(file.absolutePath, content.content);
      } else if (!cachedDiff?.rows.length) {
        removeChangedFile(file.absolutePath);
      }
      knownPathsRef.current.add(file.absolutePath);
      setSelected(content);
      setSelectedAbsolutePath(file.absolutePath);
      setDiff(nextDiff?.rows.length ? nextDiff : null);
      setChangedLine(nextDiff?.firstChangedLine ?? null);
      setViewMode((current) => (auto ? 'diff' : current));
      if (auto) {
        setAutoSwitching(true);
        window.setTimeout(() => setAutoSwitching(false), 1_600);
      }
      if (!nextDiff?.rows.length) {
        setChangedLine(null);
      }
      saveTrackerStateSnapshot();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function seedBaselines(files: RecentChangedFile[], replace = false) {
    const seedFiles = files.slice(0, 80).filter((file) => replace || !previousContentRef.current.has(file.absolutePath));
    await Promise.all(seedFiles.map(async (file) => {
      try {
        const content = await readContextFile(file.absolutePath);
        previousContentRef.current.set(file.absolutePath, content.content);
      } catch {
        // Baseline seeding is best-effort; opening the file will surface read errors if needed.
      }
    }));
    saveTrackerStateSnapshot();
  }

  async function captureChangedFileDiffs(files: RecentChangedFile[]) {
    const candidates = files
      .filter((file) => previousContentRef.current.has(file.absolutePath))
      .filter((file) => !diffByPathRef.current.has(file.absolutePath) || changes.find((item) => item.absolutePath === file.absolutePath)?.modifiedMs !== file.modifiedMs)
      .slice(0, 20);
    const changedFiles: RecentChangedFile[] = [];
    await Promise.all(candidates.map(async (file) => {
      try {
        const baseline = previousContentRef.current.get(file.absolutePath);
        if (baseline === undefined) {
          return;
        }
        const content = await readContextFile(file.absolutePath);
        if (baseline === content.content) {
          return;
        }
        const calculatedDiff = buildLineDiff(baseline, content.content);
        if (calculatedDiff.rows.length) {
          diffByPathRef.current.set(file.absolutePath, calculatedDiff);
          changedFiles.push(file);
        }
      } catch {
        // Opening the file later will surface read errors if needed.
      }
    }));
    if (changedFiles.length === 0) {
      return;
    }
    setChanges((current) => {
      const changedByPath = new Map(changedFiles.map((file) => [file.absolutePath, file]));
      const next = sortChangedFilesByModifiedTime([
        ...changedFiles,
        ...current.filter((file) => !changedByPath.has(file.absolutePath)),
      ]).slice(0, MAX_PERSISTED_TRACKED_FILES);
      saveTrackerStateSnapshot(next);
      return next;
    });
  }

  function upsertChangedFile(file: RecentChangedFile) {
    setChanges((current) => {
      const next = sortChangedFilesByModifiedTime([
        file,
        ...current.filter((item) => item.absolutePath !== file.absolutePath),
      ]).slice(0, MAX_PERSISTED_TRACKED_FILES);
      saveTrackerStateSnapshot(next);
      return next;
    });
  }

  function removeChangedFile(path: string) {
    setChanges((current) => {
      const next = current.filter((item) => item.absolutePath !== path);
      saveTrackerStateSnapshot(next);
      return next;
    });
  }

  function pruneMissingChangedFiles(files: RecentChangedFile[]) {
    const available = new Set(files.map((file) => file.absolutePath));
    setChanges((current) => {
      const next = current.filter((file) => available.has(file.absolutePath) && diffByPathRef.current.has(file.absolutePath));
      saveTrackerStateSnapshot(next);
      return next;
    });
  }

  function saveTrackerStateSnapshot(nextChanges = changes) {
    runtimeTrackerState.changes = nextChanges.slice(0, MAX_PERSISTED_TRACKED_FILES);
    runtimeTrackerState.diffByPath = diffByPathRef.current;
    runtimeTrackerState.knownPaths = knownPathsRef.current;
    runtimeTrackerState.previousContent = previousContentRef.current;
    runtimeTrackerState.selectedAbsolutePath = selectedAbsolutePath;
    runtimeTrackerState.signature = signatureRef.current;
    runtimeTrackerState.trackerStartedAt = trackerStartedAtRef.current;
    localStorage.setItem(TRACKER_STATE_KEY, JSON.stringify({
      enabled,
      listCollapsed,
      rootPath,
    } satisfies TrackerPreferences));
  }

  function insertCurrentFile() {
    if (!selected || !selectedAbsolutePath) {
      return;
    }
    onInsertText(`文件：${selectedAbsolutePath}\n\n\`\`\`${selected.extension || 'text'}\n${selected.content}\n\`\`\``);
  }

  function insertCurrentDiff() {
    if (!selected || !selectedAbsolutePath || !diff) {
      return;
    }
    const body = diff.rows.map((row) => {
      const prefix = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
      return `${prefix}${row.text}`;
    }).join('\n');
    onInsertText(`文件变更：${selectedAbsolutePath}\n新增：${diff.added} 行，删除：${diff.deleted} 行\n\n\`\`\`diff\n${body}\n\`\`\``);
  }

  return (
    <aside className={listCollapsed ? 'change-tracker-panel list-collapsed' : 'change-tracker-panel'}>
      <header className="change-tracker-header">
        <div className="change-tracker-title">
          <strong>实时追踪</strong>
          <span title={effectiveRoot ?? ''}>{effectiveRoot ? shortPath(effectiveRoot) : '未选择追踪目录'}</span>
        </div>
        <div className="change-tracker-actions">
          <button
            aria-label={listCollapsed ? '展开实时追踪文档列表' : '收起实时追踪文档列表'}
            className="change-tracker-list-toggle"
            onClick={() => setListCollapsed((current) => !current)}
            title={listCollapsed ? '展开文档列表' : '收起文档列表'}
            type="button"
          >
            {listCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
            <span>{listCollapsed ? '展开列表' : '收起列表'}</span>
          </button>
          <button className={enabled ? 'change-tracker-toggle active' : 'change-tracker-toggle'} onClick={() => setEnabled((current) => !current)} title={enabled ? '暂停实时追踪' : '开始实时追踪'} type="button">
            {enabled ? <Pause size={14} /> : <Play size={14} />}
            <span>{enabled ? '追踪中' : '已暂停'}</span>
          </button>
          <button aria-label="刷新变更" className="icon-button" disabled={loading || !effectiveRoot} onClick={() => void refreshChanges('manual')} title="刷新" type="button">
            <RefreshCw size={15} />
          </button>
          <button aria-label="重置追踪基线" className="icon-button" disabled={loading || !effectiveRoot} onClick={() => void resetTrackingBaseline()} title="重置基线：把当前文件内容作为新的对比起点" type="button">
            <RotateCcw size={15} />
          </button>
          <button aria-label="收起实时追踪" className="icon-button" onClick={onCollapse} title="收起" type="button">
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="change-tracker-body">
        <section className="change-tracker-list">
          <button
            aria-label="展开实时追踪文档列表"
            className="change-tracker-list-rail"
            onClick={() => setListCollapsed(false)}
            title="展开文档列表"
            type="button"
          >
            <PanelLeftOpen size={15} />
            <span>变更列表</span>
            <small>{changes.length}</small>
          </button>
          <div className="change-tracker-root">
            <button onClick={() => void chooseRoot()} type="button"><FolderOpen size={15} />选择目录</button>
            <span title={effectiveRoot ?? ''}>{effectiveRoot ?? '选择要追踪的目录'}</span>
          </div>
          <div className={enabled ? 'change-tracker-status active' : 'change-tracker-status'}>
            <strong>{enabled ? '正在实时追踪文件变更' : '实时追踪已暂停'}</strong>
            <span>{selected ? `当前：${selected.name}${changedLine ? ` · 第 ${changedLine} 行附近` : ''}` : '等待文件变更'}</span>
          </div>
          <div className="change-tracker-files">
            {loading && <p className="empty">正在扫描最近修改</p>}
            {!loading && changes.length === 0 && <p className="empty">暂无已捕获的红绿 Diff</p>}
            {changes.map((file) => (
              <button className={file.absolutePath === selectedAbsolutePath ? 'change-tracker-file active' : 'change-tracker-file'} key={file.absolutePath} onClick={() => void openChangedFile(file, false)} title={file.absolutePath} type="button">
                <FileSearch size={15} />
                <span>
                  <strong>{file.name}</strong>
                  <small>{file.path}</small>
                </span>
                <time>{formatTime(file.modifiedMs)}</time>
              </button>
            ))}
          </div>
        </section>

        <section className={autoSwitching ? 'change-tracker-preview auto-switched' : 'change-tracker-preview'}>
          <div className="change-tracker-preview-toolbar">
            <div>
              <strong title={selectedAbsolutePath ?? ''}>{selected?.name ?? '文件预览'}</strong>
              <span title={selectedAbsolutePath ?? ''}>{selectedAbsolutePath ?? '选择左侧最近变更文件'}</span>
            </div>
            <span className="change-tracker-preview-actions">
              <span className="change-tracker-view-tabs" aria-label="实时追踪展示模式">
                <button className={viewMode === 'content' ? 'active' : ''} disabled={!selected} onClick={() => setViewMode('content')} type="button">当前内容</button>
                <button className={viewMode === 'diff' ? 'active' : ''} disabled={!selected} onClick={() => setViewMode('diff')} type="button">变更详情</button>
              </span>
              {viewMode === 'diff' ? (
                <button disabled={!diff} onClick={insertCurrentDiff} type="button">插入变更</button>
              ) : (
                <button disabled={!selected} onClick={insertCurrentFile} type="button">插入当前文件</button>
              )}
            </span>
          </div>
          {viewMode === 'diff' ? (
            <div className="change-tracker-diff-view">
              <div className="change-tracker-diff-summary">
                <span className="add">+{diff?.added ?? 0} 新增</span>
                <span className="del">-{diff?.deleted ?? 0} 删除</span>
                <span>{diff?.firstChangedLine ? `第 ${diff.firstChangedLine} 行附近` : selected ? '首次追踪' : '等待文件变更'}</span>
                {autoSwitching && <span className="auto">已自动切换到最新变更</span>}
              </div>
              <pre className="change-tracker-diff-code" ref={diffRef}>
                {diff ? (
                  diff.rows.map((row, index) => (
                    <span
                      className={`change-tracker-diff-row ${row.kind}`}
                      data-first-change={index === firstDiffRowIndex ? 'true' : undefined}
                      key={`${row.kind}-${row.oldLine ?? ''}-${row.newLine ?? ''}-${index}`}
                    >
                      <i>{row.oldLine ?? ''}</i>
                      <i>{row.newLine ?? ''}</i>
                      <em>{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}</em>
                      <b>{row.text || ' '}</b>
                    </span>
                  ))
                ) : selected ? (
                  <span className="change-tracker-diff-empty">已建立基线，等待文件下一次保存后展示红绿 Diff</span>
                ) : (
                  '选择左侧文件后预览内容'
                )}
              </pre>
            </div>
          ) : (
            <pre className="change-tracker-code" ref={contentRef}>
              {selected ? lines.map((line, index) => (
                <span className={changedLine === index + 1 ? 'active' : ''} data-line={index + 1} key={index}>
                  <i>{index + 1}</i>
                  <b>{line || ' '}</b>
                </span>
              )) : '选择左侧文件后预览内容'}
            </pre>
          )}
        </section>
      </div>
    </aside>
  );
}

function loadTrackerState(): TrackerState {
  const preferences = loadTrackerPreferences();
  return {
    changes: runtimeTrackerState.changes,
    enabled: preferences.enabled,
    knownPaths: [...runtimeTrackerState.knownPaths],
    listCollapsed: preferences.listCollapsed,
    rootPath: preferences.rootPath,
    selectedAbsolutePath: runtimeTrackerState.selectedAbsolutePath,
    signature: runtimeTrackerState.signature,
    trackerStartedAt: runtimeTrackerState.trackerStartedAt,
  };
}

function fileSignature(files: RecentChangedFile[]) {
  return files.map((file) => `${file.absolutePath}:${file.modifiedMs}:${file.size}`).join('|');
}

function sortChangedFilesByModifiedTime(files: RecentChangedFile[]) {
  return [...files].sort((left, right) => (
    right.modifiedMs - left.modifiedMs ||
    right.createdMs - left.createdMs ||
    left.path.localeCompare(right.path)
  ));
}

function loadTrackerPreferences(): TrackerPreferences {
  const raw = localStorage.getItem(TRACKER_STATE_KEY) || '';
  if (!raw) {
    resetRuntimeTrackerState();
  }
  const preferences = parseTrackerPreferences(raw);
  if (raw && raw.includes('"baselines"')) {
    resetRuntimeTrackerState();
    localStorage.setItem(TRACKER_STATE_KEY, JSON.stringify(preferences));
  }
  return preferences;
}

function resetRuntimeTrackerState() {
  runtimeTrackerState.changes = [];
  runtimeTrackerState.diffByPath = new Map();
  runtimeTrackerState.knownPaths = new Set();
  runtimeTrackerState.previousContent = new Map();
  runtimeTrackerState.selectedAbsolutePath = null;
  runtimeTrackerState.signature = '';
  runtimeTrackerState.trackerStartedAt = Date.now();
}

function parseTrackerPreferences(raw: string): TrackerPreferences {
  if (!raw) {
    return { enabled: true, listCollapsed: false, rootPath: null };
  }
  try {
    const value = JSON.parse(raw) as Partial<TrackerPreferences>;
    return {
      enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
      listCollapsed: typeof value.listCollapsed === 'boolean' ? value.listCollapsed : false,
      rootPath: typeof value.rootPath === 'string' ? value.rootPath : null,
    };
  } catch {
    return { enabled: true, listCollapsed: false, rootPath: null };
  }
}

export function buildLineDiff(before: string, after: string): ChangeDiff {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const rows = buildDiffRows(oldLines, newLines);
  const added = rows.filter((row) => row.kind === 'add').length;
  const deleted = rows.filter((row) => row.kind === 'del').length;
  const firstChangedLine = rows.find((row) => row.kind === 'add')?.newLine
    ?? rows.find((row) => row.kind === 'del')?.oldLine
    ?? null;
  return { added, deleted, firstChangedLine, rows };
}

function buildAllAddedDiff(content: string): ChangeDiff {
  if (!content) {
    return {
      added: 0,
      deleted: 0,
      firstChangedLine: null,
      rows: [],
    };
  }
  const rows = content.split('\n').map((line, index) => ({
    kind: 'add' as const,
    oldLine: null,
    newLine: index + 1,
    text: line,
  }));
  return {
    added: rows.length,
    deleted: 0,
    firstChangedLine: rows.length > 0 ? 1 : null,
    rows,
  };
}

function buildDiffRows(oldLines: string[], newLines: string[]): ChangeDiffRow[] {
  if (oldLines.length * newLines.length > 200_000) {
    return buildAnchoredDiff(oldLines, newLines);
  }
  const table = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0));
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? table[oldIndex + 1][newIndex + 1] + 1
        : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }
  const rows: ChangeDiffRow[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      rows.push({ kind: 'context', oldLine: oldIndex + 1, newLine: newIndex + 1, text: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      rows.push({ kind: 'del', oldLine: oldIndex + 1, newLine: null, text: oldLines[oldIndex] });
      oldIndex += 1;
    } else {
      rows.push({ kind: 'add', oldLine: null, newLine: newIndex + 1, text: newLines[newIndex] });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    rows.push({ kind: 'del', oldLine: oldIndex + 1, newLine: null, text: oldLines[oldIndex] });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    rows.push({ kind: 'add', oldLine: null, newLine: newIndex + 1, text: newLines[newIndex] });
    newIndex += 1;
  }
  return compactContextRows(rows);
}

function buildAnchoredDiff(oldLines: string[], newLines: string[]): ChangeDiffRow[] {
  const anchors = findUniqueOrderedAnchors(oldLines, newLines);
  if (anchors.length === 0) {
    return buildPrefixSuffixDiff(oldLines, newLines);
  }
  const rows: ChangeDiffRow[] = [];
  let oldStart = 0;
  let newStart = 0;
  for (const anchor of anchors) {
    rows.push(...buildDiffSegment(oldLines, newLines, oldStart, anchor.oldIndex, newStart, anchor.newIndex));
    rows.push({
      kind: 'context',
      oldLine: anchor.oldIndex + 1,
      newLine: anchor.newIndex + 1,
      text: oldLines[anchor.oldIndex],
    });
    oldStart = anchor.oldIndex + 1;
    newStart = anchor.newIndex + 1;
  }
  rows.push(...buildDiffSegment(oldLines, newLines, oldStart, oldLines.length, newStart, newLines.length));
  return compactContextRows(rows);
}

function buildDiffSegment(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): ChangeDiffRow[] {
  const oldSegment = oldLines.slice(oldStart, oldEnd);
  const newSegment = newLines.slice(newStart, newEnd);
  const segmentRows = oldSegment.length * newSegment.length <= 80_000
    ? buildExactDiffRows(oldSegment, newSegment)
    : buildPrefixSuffixDiff(oldSegment, newSegment);
  return segmentRows.map((row) => ({
    ...row,
    oldLine: row.oldLine === null ? null : row.oldLine + oldStart,
    newLine: row.newLine === null ? null : row.newLine + newStart,
  }));
}

function buildExactDiffRows(oldLines: string[], newLines: string[]): ChangeDiffRow[] {
  const table = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0));
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? table[oldIndex + 1][newIndex + 1] + 1
        : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }
  const rows: ChangeDiffRow[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      rows.push({ kind: 'context', oldLine: oldIndex + 1, newLine: newIndex + 1, text: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      rows.push({ kind: 'del', oldLine: oldIndex + 1, newLine: null, text: oldLines[oldIndex] });
      oldIndex += 1;
    } else {
      rows.push({ kind: 'add', oldLine: null, newLine: newIndex + 1, text: newLines[newIndex] });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    rows.push({ kind: 'del', oldLine: oldIndex + 1, newLine: null, text: oldLines[oldIndex] });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    rows.push({ kind: 'add', oldLine: null, newLine: newIndex + 1, text: newLines[newIndex] });
    newIndex += 1;
  }
  return rows;
}

function findUniqueOrderedAnchors(oldLines: string[], newLines: string[]) {
  const oldCounts = countLines(oldLines);
  const newCounts = countLines(newLines);
  const newIndexByLine = new Map<string, number>();
  newLines.forEach((line, index) => {
    if (newCounts.get(line) === 1) {
      newIndexByLine.set(line, index);
    }
  });
  const candidates = oldLines
    .map((line, oldIndex) => (
      oldCounts.get(line) === 1 && newCounts.get(line) === 1
        ? { newIndex: newIndexByLine.get(line) ?? -1, oldIndex }
        : null
    ))
    .filter((item): item is { newIndex: number; oldIndex: number } => item !== null && item.newIndex >= 0);
  return longestIncreasingByNewIndex(candidates);
}

function countLines(lines: string[]) {
  const counts = new Map<string, number>();
  lines.forEach((line) => counts.set(line, (counts.get(line) ?? 0) + 1));
  return counts;
}

function longestIncreasingByNewIndex(candidates: Array<{ newIndex: number; oldIndex: number }>) {
  const tails: number[] = [];
  const previous = new Array<number>(candidates.length).fill(-1);
  const tailCandidateIndexes: number[] = [];
  candidates.forEach((candidate, index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (tails[middle] < candidate.newIndex) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low > 0) {
      previous[index] = tailCandidateIndexes[low - 1];
    }
    tails[low] = candidate.newIndex;
    tailCandidateIndexes[low] = index;
  });
  const result: Array<{ newIndex: number; oldIndex: number }> = [];
  let current = tailCandidateIndexes[tails.length - 1] ?? -1;
  while (current >= 0) {
    result.push(candidates[current]);
    current = previous[current];
  }
  return result.reverse();
}

function buildPrefixSuffixDiff(oldLines: string[], newLines: string[]): ChangeDiffRow[] {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix + prefix < oldLines.length &&
    suffix + prefix < newLines.length &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const rows: ChangeDiffRow[] = [];
  for (let index = 0; index < prefix; index += 1) {
    rows.push({ kind: 'context', oldLine: index + 1, newLine: index + 1, text: oldLines[index] });
  }
  for (let index = prefix; index < oldLines.length - suffix; index += 1) {
    rows.push({ kind: 'del', oldLine: index + 1, newLine: null, text: oldLines[index] });
  }
  for (let index = prefix; index < newLines.length - suffix; index += 1) {
    rows.push({ kind: 'add', oldLine: null, newLine: index + 1, text: newLines[index] });
  }
  for (let index = oldLines.length - suffix; index < oldLines.length; index += 1) {
    const newLine = newLines.length - oldLines.length + index + 1;
    rows.push({ kind: 'context', oldLine: index + 1, newLine, text: oldLines[index] });
  }
  return compactContextRows(rows);
}

function compactContextRows(rows: ChangeDiffRow[]) {
  if (!rows.some((row) => row.kind !== 'context')) {
    return [];
  }
  const keep = new Set<number>();
  rows.forEach((row, index) => {
    if (row.kind === 'context') {
      return;
    }
    for (let offset = -4; offset <= 4; offset += 1) {
      const next = index + offset;
      if (next >= 0 && next < rows.length) {
        keep.add(next);
      }
    }
  });
  const compacted: ChangeDiffRow[] = [];
  let skipped = false;
  rows.forEach((row, index) => {
    if (keep.has(index)) {
      if (skipped) {
        compacted.push({ kind: 'context', oldLine: null, newLine: null, text: '...' });
        skipped = false;
      }
      compacted.push(row);
    } else {
      skipped = true;
    }
  });
  return compacted;
}

function shortPath(path: string) {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(-3).join('/') || path;
}

function formatTime(value: number) {
  if (!value) {
    return '';
  }
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function scrollIntoViewIfPossible(target: Element | null | undefined) {
  if (!target || typeof target.scrollIntoView !== 'function') {
    return;
  }
  target.scrollIntoView({ block: 'center' });
}
