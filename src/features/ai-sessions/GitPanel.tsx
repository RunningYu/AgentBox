import { ChevronDown, ChevronRight, GitBranch, RefreshCw, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { chooseDocumentDirectory } from './documentApi';
import {
  listGitRoots,
  listGitStatus,
  readGitDiff,
  type GitChangedFile,
  type GitRootInfo,
  type GitStatusSummary,
} from './gitApi';

type GitFilter = 'all' | 'M' | 'A' | 'D' | 'R' | '??';
type GitPathFilterMode = 'all' | 'code' | 'custom';
type GitChangeScope = 'all' | 'changes' | 'unversioned';
type GitGroupMode = 'root' | 'directory' | 'flat';
type GitPromptAction = 'insert' | 'explain' | 'review' | 'commit';
type GitFollowMode = 'jump' | 'notify' | 'off';
type GitRangeMode = 'repo' | 'cwd' | 'custom';

interface GitPanelProps {
  cwd: string | null;
  onCollapse: () => void;
  onError: (message: string) => void;
  onInsertText: (text: string) => void;
}

interface GitPathFilterPrefs {
  excludeText: string;
  includeText: string;
  mode: GitPathFilterMode;
}

interface GitFileGroup {
  branch: string;
  color: string;
  id: string;
  label: string;
  files: GitPanelFile[];
}

interface GitPanelFile extends GitChangedFile {
  branch: string;
  key: string;
  root: string;
  rootName: string;
}

interface ParsedDiffLine {
  className: string;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

interface GitFollowLocation {
  hunk: string;
  line: number | null;
  path: string;
}

const FILTERS: Array<{ label: string; value: GitFilter }> = [
  { label: '全部', value: 'all' },
  { label: '修改', value: 'M' },
  { label: '新增', value: 'A' },
  { label: '删除', value: 'D' },
  { label: '重命名', value: 'R' },
  { label: '未跟踪', value: '??' },
];

const SCOPE_OPTIONS: Array<{ label: string; value: GitChangeScope }> = [
  { label: '全部', value: 'all' },
  { label: 'Changes', value: 'changes' },
  { label: 'Unversioned Files', value: 'unversioned' },
];

const GROUP_OPTIONS: Array<{ label: string; value: GitGroupMode }> = [
  { label: '按仓库/模块', value: 'root' },
  { label: '按目录', value: 'directory' },
  { label: '平铺', value: 'flat' },
];

const PATH_FILTER_STORAGE_KEY = 'agentbox.git-path-filter.v1';
const GIT_PANEL_STORAGE_KEY = 'agentbox.git-panel-state.v1';
const GIT_FOLLOW_INTERVAL_MS = 2_000;
const GIT_FOLLOW_MANUAL_PAUSE_MS = 10_000;
const CODE_EXTENSIONS = new Set([
  'java', 'kt', 'kotlin', 'ts', 'tsx', 'js', 'jsx', 'vue', 'rs', 'go', 'py', 'sql', 'xml',
  'yaml', 'yml', 'properties', 'gradle', 'proto', 'thrift', 'json', 'md',
]);
const CODE_FILE_NAMES = new Set([
  'pom.xml', 'build.gradle', 'settings.gradle', 'gradle.properties', 'application.yml',
  'application.yaml', 'application.properties', 'package.json', 'tsconfig.json', 'vite.config.ts',
]);
const DEFAULT_EXCLUDED_PATH_PREFIXES = [
  'target/', 'dist/', 'build/', 'node_modules/', '.idea/', '.git/', '.gradle/', 'coverage/',
  'src-tauri/target/',
];
const DEFAULT_EXCLUDED_FILE_SUFFIXES = [
  '.lock', '.log', '.class', '.jar', '.war', '.zip', '.tar', '.gz', '.png', '.jpg', '.jpeg',
  '.gif', '.webp', '.icns', '.ico', '.dmg', '.pdf',
];
const DEFAULT_EXCLUDED_FILE_NAMES = new Set(['package-lock.json', 'Cargo.lock', 'yarn.lock', 'pnpm-lock.yaml']);
const GROUP_COLORS = ['#7aa2f7', '#8fc56b', '#c678dd', '#e5a152', '#56b6c2', '#d19a66', '#98c379'];

export function GitPanel({ cwd, onCollapse, onError, onInsertText }: GitPanelProps) {
  const [roots, setRoots] = useState<GitRootInfo[]>([]);
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const [status, setStatus] = useState<GitStatusSummary | null>(null);
  const [statuses, setStatuses] = useState<GitStatusSummary[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [diff, setDiff] = useState('');
  const [filter, setFilter] = useState<GitFilter>('all');
  const [scope, setScope] = useState<GitChangeScope>(() => loadPanelPrefs().scope);
  const [groupMode, setGroupMode] = useState<GitGroupMode>(() => loadPanelPrefs().groupMode);
  const [pathFilter, setPathFilter] = useState<GitPathFilterPrefs>(() => loadPathFilterPrefs());
  const [followMode, setFollowMode] = useState<GitFollowMode>(() => loadPanelPrefs().followMode);
  const [rangeMode, setRangeMode] = useState<GitRangeMode>(() => loadPanelPrefs().rangeMode);
  const [rangePath, setRangePath] = useState(() => loadPanelPrefs().rangePath);
  const [latestChangedPath, setLatestChangedPath] = useState<string | null>(null);
  const [followPausedUntil, setFollowPausedUntil] = useState(0);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [fileColumnWidth, setFileColumnWidth] = useState(() => loadPanelPrefs().fileColumnWidth);
  const [loadingRoots, setLoadingRoots] = useState(false);
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const diffRef = useRef<HTMLPreElement | null>(null);
  const statusSignatureRef = useRef('');

  const activeRoot = roots.find((root) => root.root === selectedRoot) ?? roots[0] ?? null;
  const effectiveRoot = activeRoot?.root ?? selectedRoot ?? cwd;
  const rangePattern = useMemo(() => resolveRangePattern(rangeMode, rangePath, cwd, effectiveRoot), [cwd, effectiveRoot, rangeMode, rangePath]);
  const activePanelRoots = useMemo(
    () => resolveActivePanelRoots(rangeMode, rangePath, cwd, effectiveRoot, roots),
    [cwd, effectiveRoot, rangeMode, rangePath, roots],
  );
  const files = useMemo(() => flattenStatusFiles(statuses, roots), [roots, statuses]);
  const visibleFiles = useMemo(
    () => files.filter((file) => (
      matchesScope(file, scope)
      && (filter === 'all' || file.status === filter)
      && matchesFileRange(file, rangeMode, rangePath, cwd)
      && matchesPathFilter(file.path, pathFilter)
    )),
    [cwd, files, filter, pathFilter, rangeMode, rangePath, scope],
  );
  const groupedChanges = useMemo(
    () => buildSectionGroups(visibleFiles.filter((file) => file.status !== '??'), groupMode, status, activeRoot),
    [activeRoot, groupMode, status, visibleFiles],
  );
  const groupedUnversioned = useMemo(
    () => buildSectionGroups(visibleFiles.filter((file) => file.status === '??'), groupMode, status, activeRoot),
    [activeRoot, groupMode, status, visibleFiles],
  );
  const selectedFile = visibleFiles.find((file) => file.key === selectedPath) ?? visibleFiles[0] ?? null;
  const parsedDiff = useMemo(() => parseDiffLines(diff), [diff]);
  const followLocation = useMemo(() => (
    latestChangedPath && latestChangedPath === selectedFile?.key
      ? resolveFollowLocation(selectedFile.path, parsedDiff)
      : null
  ), [latestChangedPath, parsedDiff, selectedFile?.key, selectedFile?.path]);
  const followPaused = followMode !== 'off' && Date.now() < followPausedUntil;

  useEffect(() => {
    localStorage.setItem(PATH_FILTER_STORAGE_KEY, JSON.stringify(pathFilter));
  }, [pathFilter]);

  useEffect(() => {
    localStorage.setItem(GIT_PANEL_STORAGE_KEY, JSON.stringify({ fileColumnWidth, followMode, groupMode, rangeMode, rangePath, scope }));
  }, [fileColumnWidth, followMode, groupMode, rangeMode, rangePath, scope]);

  useEffect(() => {
    void refreshRoots();
  }, [cwd]);

  useEffect(() => {
    if (rangeMode !== 'custom' || !rangePath) {
      return;
    }
    const matchedRoot = findRootForPath(rangePath, roots, effectiveRoot);
    if (matchedRoot && matchedRoot.root !== selectedRoot) {
      setSelectedRoot(matchedRoot.root);
      setSelectedPath(null);
      setOpenTabs([]);
    }
  }, [effectiveRoot, rangeMode, rangePath, roots, selectedRoot]);

  useEffect(() => {
    if (effectiveRoot) {
      void refreshStatus({ source: 'manual' });
    } else {
      setStatus(null);
      setStatuses([]);
      setSelectedPath(null);
      setOpenTabs([]);
      setDiff('');
    }
  }, [activePanelRoots.map((root) => root.root).join('|'), effectiveRoot]);

  useEffect(() => {
    if (!effectiveRoot || followMode === 'off') {
      return;
    }
    const timer = window.setInterval(() => {
      if (document.hidden) {
        return;
      }
      void refreshStatus({ source: 'follow' });
    }, GIT_FOLLOW_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [activePanelRoots.map((root) => root.root).join('|'), effectiveRoot, followMode, followPausedUntil]);

  useEffect(() => {
    if (selectedFile && selectedPath !== selectedFile.path) {
      selectFile(selectedFile.path);
    }
    if (!selectedFile && selectedPath !== null) {
      setSelectedPath(null);
      setOpenTabs([]);
    }
  }, [selectedFile, selectedPath]);

  useEffect(() => {
    if (!selectedFile) {
      setDiff('');
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    void readGitDiff(selectedFile.root, selectedFile.path)
      .then((result) => {
        if (!cancelled) {
          setDiff(result.diff || '这个文件当前没有可展示的 diff。');
        }
      })
      .catch((error) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setDiff(message);
          onError(message);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDiffLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onError, selectedFile?.key]);

  useEffect(() => {
    if (!followLocation || diffLoading) {
      return;
    }
    const target = diffRef.current?.querySelector('[data-follow-line="true"]');
    target?.scrollIntoView({ block: 'center' });
  }, [diffLoading, followLocation]);

  async function refreshRoots() {
    if (!cwd) {
      setRoots([]);
      setSelectedRoot(null);
      return;
    }
    try {
      setLoadingRoots(true);
      const nextRoots = await listGitRoots(cwd);
      setRoots(nextRoots);
      setSelectedRoot((current) => {
        if (current && nextRoots.some((root) => root.root === current)) {
          return current;
        }
        return nextRoots[0]?.root ?? cwd;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRoots([]);
      setSelectedRoot(cwd);
      onError(message.includes('not a git repository') ? '当前工作目录不是 Git 仓库' : message);
    } finally {
      setLoadingRoots(false);
    }
  }

  async function refreshStatus(options: { source: 'manual' | 'follow' }) {
    try {
      if (options.source === 'manual') {
        setLoading(true);
      }
      const rootsToRead = activePanelRoots.length > 0 ? activePanelRoots : effectiveRoot ? [{ branch: '', name: shortPath(effectiveRoot), root: effectiveRoot }] : [];
      const nextStatuses = await Promise.all(rootsToRead.map((root) => listGitStatus(root.root)));
      const nextFiles = flattenStatusFiles(nextStatuses, roots);
      handleFollowStatus(nextFiles, options.source);
      setStatuses(nextStatuses);
      setStatus(nextStatuses[0] ?? null);
      setSelectedPath((current) => (current && nextFiles.some((file) => file.key === current) ? current : null));
      setOpenTabs((current) => current.filter((key) => nextFiles.some((file) => file.key === key)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(null);
      setSelectedPath(null);
      setOpenTabs([]);
      setDiff('');
      onError(message.includes('not a git repository') ? '当前工作目录不是 Git 仓库' : message);
    } finally {
      if (options.source === 'manual') {
        setLoading(false);
      }
    }
  }

  function handleFollowStatus(nextFiles: GitPanelFile[], source: 'manual' | 'follow') {
    const signature = statusSignature(nextFiles);
    const previous = statusSignatureRef.current;
    statusSignatureRef.current = signature;
    if (source !== 'follow' || followMode === 'off' || !previous || previous === signature) {
      return;
    }
    const latestFile = findLatestChangedFile(nextFiles);
    if (!latestFile) {
      return;
    }
    setLatestChangedPath(latestFile.key);
    if (followMode === 'jump' && Date.now() >= followPausedUntil) {
      setSelectedPath(latestFile.key);
      setOpenTabs((current) => [latestFile.key, ...current.filter((item) => item !== latestFile.key)].slice(0, 12));
    }
  }

  function pauseFollowForManualAction() {
    if (followMode !== 'off') {
      setFollowPausedUntil(Date.now() + GIT_FOLLOW_MANUAL_PAUSE_MS);
    }
  }

  function selectFile(key: string, options: { manual?: boolean } = {}) {
    if (options.manual) {
      pauseFollowForManualAction();
    }
    setSelectedPath(key);
    setOpenTabs((current) => [key, ...current.filter((item) => item !== key)].slice(0, 12));
  }

  function closeTab(key: string) {
    setOpenTabs((current) => current.filter((item) => item !== key));
    if (key === selectedPath) {
      const nextPath = openTabs.find((item) => item !== key) ?? visibleFiles.find((file) => file.key !== key)?.key ?? null;
      setSelectedPath(nextPath);
    }
  }

  function runDiffAction(action: GitPromptAction) {
    if (!selectedFile) {
      onError('请先选择一个变更文件');
      return;
    }
    onInsertText(formatDiffPrompt(action, selectedFile, diff, status));
  }

  async function chooseRangeDirectory() {
    try {
      const path = await chooseDocumentDirectory();
      if (!path) {
        return;
      }
      const matchedRoot = findRootForPath(path, roots, effectiveRoot);
      if (matchedRoot) {
        setSelectedRoot(matchedRoot.root);
      }
      setRangeMode('custom');
      setRangePath(path);
      setSelectedPath(null);
      setOpenTabs([]);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  function startFileColumnResize(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const divider = event.currentTarget;
    const startX = event.clientX;
    const startWidth = fileColumnWidth;
    const maxWidth = Math.max(280, (bodyRef.current?.clientWidth ?? 760) - 260);
    divider.setPointerCapture(event.pointerId);
    divider.classList.add('active');
    document.body.classList.add('resizing-layout');
    const move = (moveEvent: globalThis.PointerEvent) => {
      setFileColumnWidth(clamp(startWidth + moveEvent.clientX - startX, 180, maxWidth));
    };
    const up = (upEvent: globalThis.PointerEvent) => {
      divider.releasePointerCapture(upEvent.pointerId);
      divider.classList.remove('active');
      document.body.classList.remove('resizing-layout');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  return (
    <aside className="git-panel">
      <header className="git-panel-header">
        <div className="git-panel-title">
          <strong>Git 变更</strong>
          <span title={status?.root ?? cwd ?? ''}>{status ? `${shortPath(status.root)} · ${status.branch || 'HEAD'}` : cwd ?? '当前没有会话目录'}</span>
        </div>
        <div className="git-panel-actions">
          <select
            aria-label="切换 Git 变更范围"
            className="git-root-select"
            disabled={loadingRoots || roots.length === 0}
            onChange={(event) => {
              setSelectedRoot(event.target.value);
              setSelectedPath(null);
              setOpenTabs([]);
            }}
            title={activeRoot?.root ?? selectedRoot ?? ''}
            value={activeRoot?.root ?? selectedRoot ?? ''}
          >
            {(roots.length > 0 ? roots : selectedRoot ? [{ branch: '', name: shortPath(selectedRoot), root: selectedRoot }] : []).map((root) => (
              <option key={root.root} value={root.root}>{root.name}{root.branch ? ` · ${root.branch}` : ''}</option>
            ))}
          </select>
          <span className="git-readonly-badge">只读</span>
          <select
            aria-label="实时跟随模式"
            className={followMode === 'off' ? 'git-follow-select' : 'git-follow-select active'}
            onChange={(event) => {
              setFollowMode(event.target.value as GitFollowMode);
              setFollowPausedUntil(0);
            }}
            title="实时跟随代码变更"
            value={followMode}
          >
            <option value="jump">实时跟随</option>
            <option value="notify">只提醒</option>
            <option value="off">关闭跟随</option>
          </select>
          <button aria-label="刷新 Git 变更" className="icon-button" disabled={loading || !effectiveRoot} onClick={() => effectiveRoot && void refreshStatus({ source: 'manual' })} title="刷新 Git 变更" type="button">
            <RefreshCw size={15} />
          </button>
          <button aria-label="收起 Git" className="icon-button" onClick={onCollapse} title="收起 Git" type="button">
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="git-panel-body" ref={bodyRef} style={{ '--git-file-column-width': `${fileColumnWidth}px` } as CSSProperties}>
        <section className="git-file-column">
          <div className="git-repo-summary">
            <GitBranch size={15} />
            <span title={status?.root ?? activeRoot?.root ?? ''}>{status?.branch || activeRoot?.branch || '未读取分支'}</span>
          </div>
          <div className="git-range-filter" aria-label="Git 变更范围">
            <div className="git-range-filter-header">
              <strong>变更范围</strong>
              <button onClick={() => void chooseRangeDirectory()} type="button">选择目录</button>
            </div>
            <div className="git-range-tabs">
              <button className={rangeMode === 'repo' ? 'active' : ''} onClick={() => setRangeMode('repo')} type="button">整个仓库</button>
              <button className={rangeMode === 'cwd' ? 'active' : ''} disabled={!cwd} onClick={() => setRangeMode('cwd')} title={cwd ?? ''} type="button">会话目录</button>
              <button className={rangeMode === 'custom' ? 'active' : ''} onClick={() => setRangeMode('custom')} type="button">自定义</button>
            </div>
            {rangeMode === 'custom' && (
              <input
                aria-label="Git 自定义变更范围"
                onChange={(event) => setRangePath(event.target.value)}
                placeholder="可输入绝对路径或仓库内相对路径"
                title={rangePath}
                value={rangePath}
              />
            )}
            <span title={rangeDescription(rangeMode, rangePattern, rangePath, cwd)}>
              {rangeDescription(rangeMode, rangePattern, rangePath, cwd)}
            </span>
          </div>
          <div className="git-scope-tabs" aria-label="Git 展示范围">
            {SCOPE_OPTIONS.map((item) => (
              <button className={scope === item.value ? 'active' : ''} key={item.value} onClick={() => setScope(item.value)} type="button">
                {item.label}
              </button>
            ))}
          </div>
          <div className="git-filter-row">
            <label>
              <span>分组</span>
              <select aria-label="Git 分组方式" onChange={(event) => setGroupMode(event.target.value as GitGroupMode)} value={groupMode}>
                {GROUP_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <label>
              <span>状态</span>
              <select aria-label="Git 状态筛选" onChange={(event) => setFilter(event.target.value as GitFilter)} value={filter}>
                {FILTERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
          </div>
          <div className="git-path-filter" aria-label="Git 路径筛选">
            <div className="git-path-filter-tabs">
              <button className={pathFilter.mode === 'all' ? 'active' : ''} onClick={() => setPathFilter((current) => ({ ...current, mode: 'all' }))} type="button">全部变更</button>
              <button className={pathFilter.mode === 'code' ? 'active' : ''} onClick={() => setPathFilter((current) => ({ ...current, mode: 'code' }))} type="button">只看工程代码</button>
              <button className={pathFilter.mode === 'custom' ? 'active' : ''} onClick={() => setPathFilter((current) => ({ ...current, mode: 'custom' }))} type="button">自定义</button>
            </div>
            {pathFilter.mode === 'custom' && (
              <div className="git-path-filter-custom">
                <label>
                  <span>只看目录/路径</span>
                  <textarea
                    aria-label="Git 只看目录或路径"
                    onChange={(event) => setPathFilter((current) => ({ ...current, includeText: event.target.value }))}
                    placeholder="如：sample-service/service/src/main/java/"
                    rows={2}
                    value={pathFilter.includeText}
                  />
                </label>
                <label>
                  <span>屏蔽目录/路径</span>
                  <textarea
                    aria-label="Git 屏蔽目录或路径"
                    onChange={(event) => setPathFilter((current) => ({ ...current, excludeText: event.target.value }))}
                    placeholder="如：target/, dist/, src/test/"
                    rows={2}
                    value={pathFilter.excludeText}
                  />
                </label>
              </div>
            )}
            {pathFilter.mode === 'code' && (
              <p className="git-path-filter-hint">已排除构建产物、锁文件、二进制资源，只保留常见工程代码和配置。</p>
            )}
          </div>
          <div className={followMode === 'off' ? 'git-follow-status' : followPaused ? 'git-follow-status paused' : 'git-follow-status active'}>
            <strong>{followStatusLabel(followMode, followPaused)}</strong>
            <span title={followLocation?.path ?? latestChangedPath ?? ''}>
              {followLocation ? `${fileName(followLocation.path)} 第 ${followLocation.line ?? '?'} 行附近` : latestChangedPath ? `${fileName(latestChangedPath)} 有新变更` : '等待新的 Git 变更'}
            </span>
          </div>
          <div className="git-file-list">
            {loading && <p className="empty">正在读取 Git 状态</p>}
            {!loading && status && visibleFiles.length === 0 && <p className="empty">没有匹配的变更文件</p>}
            {!loading && !status && <p className="empty">请选择 Git 仓库里的会话目录</p>}
            <GitSection
              collapsedGroups={collapsedGroups}
              groups={groupedChanges}
              latestChangedPath={latestChangedPath}
              onSelect={(path) => selectFile(path, { manual: true })}
              onToggleGroup={(id) => setCollapsedGroups((current) => ({ ...current, [id]: !current[id] }))}
              selectedPath={selectedFile?.path ?? null}
              title="Changes"
            />
            <GitSection
              collapsedGroups={collapsedGroups}
              groups={groupedUnversioned}
              latestChangedPath={latestChangedPath}
              onSelect={(path) => selectFile(path, { manual: true })}
              onToggleGroup={(id) => setCollapsedGroups((current) => ({ ...current, [id]: !current[id] }))}
              selectedPath={selectedFile?.path ?? null}
              title="Unversioned Files"
            />
          </div>
        </section>

        <div
          aria-label="调整 Git 变更列表宽度"
          className="layout-resize-divider git-file-resize-divider"
          onPointerDown={startFileColumnResize}
          role="separator"
        />

        <section className="git-diff-column">
          <div className="git-open-tabs" aria-label="已打开的 Git 文件">
            {openTabs.length === 0 && <span className="git-open-tabs-empty">选择左侧变更文件</span>}
            {openTabs.map((path) => (
              <button className={path === selectedFile?.key ? 'git-open-tab active' : 'git-open-tab'} key={path} onClick={() => selectFile(path, { manual: true })} title={path} type="button">
                <span>{fileName(displayPathFromKey(path))}</span>
                <i onClick={(event) => { event.stopPropagation(); closeTab(path); }}>×</i>
              </button>
            ))}
          </div>
          <div className="git-diff-toolbar">
            <div>
              <strong title={selectedFile?.path ?? ''}>{selectedFile?.path.split('/').pop() ?? 'Diff'}</strong>
              <span title={selectedFile?.path ?? ''}>{selectedFile?.path ?? '选择左侧变更文件'}</span>
            </div>
            <div className="git-diff-actions">
              <button disabled={!selectedFile} onClick={() => runDiffAction('insert')} type="button">插入 Diff</button>
              <button disabled={!selectedFile} onClick={() => runDiffAction('explain')} type="button">解释</button>
              <button disabled={!selectedFile} onClick={() => runDiffAction('review')} type="button">审查</button>
              <button disabled={!selectedFile} onClick={() => runDiffAction('commit')} type="button">提交说明</button>
            </div>
          </div>
          <pre className="git-diff-code" aria-label="Git Diff 内容" onWheel={pauseFollowForManualAction} ref={diffRef}>
            {diffLoading ? '正在读取 diff...' : <GitDiffText followLine={followLocation?.line ?? null} lines={parsedDiff} />}
          </pre>
        </section>
      </div>
    </aside>
  );
}

function GitSection({
  collapsedGroups,
  groups,
  latestChangedPath,
  onSelect,
  onToggleGroup,
  selectedPath,
  title,
}: {
  collapsedGroups: Record<string, boolean>;
  groups: GitFileGroup[];
  latestChangedPath: string | null;
  onSelect: (path: string) => void;
  onToggleGroup: (id: string) => void;
  selectedPath: string | null;
  title: string;
}) {
  const total = groups.reduce((sum, group) => sum + group.files.length, 0);
  if (total === 0) {
    return null;
  }
  return (
    <div className="git-change-section">
      <div className="git-change-section-title">
        <ChevronDown size={14} />
        <strong>{title}</strong>
        <span>{total} files</span>
      </div>
      {groups.map((group) => {
        const collapsed = collapsedGroups[group.id] ?? false;
        return (
          <div className="git-change-group" key={group.id}>
            <button className="git-change-group-title" onClick={() => onToggleGroup(group.id)} title={`${group.label} · ${group.branch}`} type="button">
              {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <input aria-label={`选择 ${group.label}`} checked readOnly type="checkbox" />
              <span className="git-group-dot" style={{ backgroundColor: group.color }} />
              <strong>{group.label}</strong>
              <small>{group.files.length} files</small>
              {group.branch && <em>{group.branch}</em>}
            </button>
            {!collapsed && group.files.map((file) => (
              <button className={`${file.key === selectedPath ? 'git-file-row active' : 'git-file-row'} ${file.key === latestChangedPath ? 'hot' : ''}`} key={file.key} onClick={() => onSelect(file.key)} title={`${file.rootName}: ${file.path}`} type="button">
                <span className={`git-status git-status-${statusClass(file.status)}`}>{file.status}</span>
                <strong>{fileName(file.path)}</strong>
                <small>{pathWithoutFile(file.path)}</small>
                {file.key === latestChangedPath && <em>刚刚变更</em>}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function loadPanelPrefs(): { fileColumnWidth: number; followMode: GitFollowMode; groupMode: GitGroupMode; rangeMode: GitRangeMode; rangePath: string; scope: GitChangeScope } {
  try {
    const value = JSON.parse(localStorage.getItem(GIT_PANEL_STORAGE_KEY) || '{}') as Partial<{ fileColumnWidth: number; followMode: GitFollowMode; groupMode: GitGroupMode; rangeMode: GitRangeMode; rangePath: string; scope: GitChangeScope }>;
    return {
      fileColumnWidth: typeof value.fileColumnWidth === 'number' ? clamp(value.fileColumnWidth, 180, 720) : 320,
      followMode: value.followMode === 'jump' || value.followMode === 'notify' ? value.followMode : 'off',
      groupMode: value.groupMode === 'directory' || value.groupMode === 'flat' ? value.groupMode : 'root',
      rangeMode: value.rangeMode === 'cwd' || value.rangeMode === 'custom' ? value.rangeMode : 'repo',
      rangePath: typeof value.rangePath === 'string' ? value.rangePath : '',
      scope: value.scope === 'changes' || value.scope === 'unversioned' ? value.scope : 'all',
    };
  } catch {
    return { fileColumnWidth: 320, followMode: 'off', groupMode: 'root', rangeMode: 'repo', rangePath: '', scope: 'all' };
  }
}

function loadPathFilterPrefs(): GitPathFilterPrefs {
  try {
    const value = JSON.parse(localStorage.getItem(PATH_FILTER_STORAGE_KEY) || '{}') as Partial<GitPathFilterPrefs>;
    return {
      excludeText: typeof value.excludeText === 'string' ? value.excludeText : '',
      includeText: typeof value.includeText === 'string' ? value.includeText : '',
      mode: value.mode === 'code' || value.mode === 'custom' ? value.mode : 'all',
    };
  } catch {
    return { excludeText: '', includeText: '', mode: 'all' };
  }
}

function buildSectionGroups(files: GitPanelFile[], groupMode: GitGroupMode, status: GitStatusSummary | null, root: GitRootInfo | null): GitFileGroup[] {
  if (files.length === 0) {
    return [];
  }
  const groups = new Map<string, GitPanelFile[]>();
  for (const file of files) {
    const key = groupMode === 'root' ? file.rootName : groupKey(file.path, groupMode, root, status);
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, groupFiles], index) => ({
      branch: groupFiles[0]?.branch ?? root?.branch ?? status?.branch ?? '',
      color: GROUP_COLORS[index % GROUP_COLORS.length],
      files: groupFiles.sort((left, right) => left.path.localeCompare(right.path)),
      id: `${groupMode}:${label}`,
      label,
    }));
}

function groupKey(path: string, groupMode: GitGroupMode, root: GitRootInfo | null, status: GitStatusSummary | null) {
  if (groupMode === 'flat') {
    return 'Default';
  }
  if (groupMode === 'root') {
    return root?.name || (status?.root ? fileName(status.root) : topSegment(path));
  }
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) {
    return '根目录';
  }
  if (parts.includes('src')) {
    const srcIndex = parts.indexOf('src');
    return parts.slice(0, Math.min(srcIndex + 3, parts.length - 1)).join('/');
  }
  return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

function flattenStatusFiles(statuses: GitStatusSummary[], roots: GitRootInfo[]): GitPanelFile[] {
  return statuses.flatMap((summary) => {
    const root = roots.find((item) => item.root === summary.root);
    const rootName = root?.name ?? fileName(summary.root);
    return summary.files.map((file) => ({
      ...file,
      branch: summary.branch,
      key: `${summary.root}::${file.path}`,
      root: summary.root,
      rootName,
    }));
  });
}

function resolveActivePanelRoots(
  mode: GitRangeMode,
  rangePath: string,
  cwd: string | null,
  root: string | null,
  roots: GitRootInfo[],
) {
  if (!root) {
    return [];
  }
  if (mode === 'repo') {
    return roots.filter((item) => item.root === root);
  }
  const source = mode === 'cwd' ? cwd : rangePath;
  if (!source) {
    return roots.filter((item) => item.root === root);
  }
  const normalizedSource = normalizeAbsolutePath(source);
  if (!isAbsolutePath(normalizedSource)) {
    return roots.filter((item) => item.root === root);
  }
  const matched = roots.filter((item) => {
    const normalizedRoot = normalizeAbsolutePath(item.root);
    return normalizedRoot === normalizedSource
      || normalizedRoot.startsWith(`${normalizedSource}/`)
      || normalizedSource.startsWith(`${normalizedRoot}/`);
  });
  if (matched.length === 0) {
    return roots.filter((item) => item.root === root);
  }
  return matched.sort((left, right) => left.root.localeCompare(right.root));
}

function matchesScope(file: GitChangedFile, scope: GitChangeScope) {
  if (scope === 'changes') {
    return file.status !== '??';
  }
  if (scope === 'unversioned') {
    return file.status === '??';
  }
  return true;
}

function resolveRangePattern(mode: GitRangeMode, rangePath: string, cwd: string | null, root: string | null) {
  if (mode === 'repo') {
    return '';
  }
  const source = mode === 'cwd' ? cwd : rangePath;
  if (!source || !root) {
    return '';
  }
  const normalizedRoot = normalizeAbsolutePath(root);
  const normalizedSource = normalizePath(source);
  if (!normalizedSource) {
    return '';
  }
  if (isAbsolutePath(normalizedSource)) {
    const normalizedAbsolute = normalizeAbsolutePath(normalizedSource);
    if (normalizedAbsolute === normalizedRoot) {
      return '';
    }
    if (normalizedAbsolute.startsWith(`${normalizedRoot}/`)) {
      return normalizedAbsolute.slice(normalizedRoot.length + 1);
    }
    if (normalizedRoot.startsWith(`${normalizedAbsolute}/`)) {
      return '';
    }
    return `__outside_git_root__/${normalizedAbsolute}`;
  }
  return normalizedSource.replace(/^\/+/, '');
}

function matchesRange(path: string, rangePattern: string) {
  if (!rangePattern) {
    return true;
  }
  if (rangePattern.startsWith('__outside_git_root__/')) {
    return false;
  }
  return pathMatchesPattern(path, rangePattern.endsWith('/') ? rangePattern : `${rangePattern}/`) || pathMatchesPattern(path, rangePattern);
}

function matchesFileRange(file: GitPanelFile, mode: GitRangeMode, rangePath: string, cwd: string | null) {
  if (mode === 'repo') {
    return true;
  }
  const source = mode === 'cwd' ? cwd : rangePath;
  if (!source) {
    return true;
  }
  const pattern = resolveRangePattern(mode, rangePath, cwd, file.root);
  if (!pattern && isAbsolutePath(normalizePath(source))) {
    const normalizedSource = normalizeAbsolutePath(source);
    const normalizedRoot = normalizeAbsolutePath(file.root);
    return normalizedSource === normalizedRoot
      || normalizedSource.startsWith(`${normalizedRoot}/`)
      || normalizedRoot.startsWith(`${normalizedSource}/`);
  }
  return matchesRange(file.path, pattern);
}

function findRootForPath(path: string, roots: GitRootInfo[], fallbackRoot: string | null) {
  const normalizedPath = normalizeAbsolutePath(path);
  const allRoots = roots.length > 0 ? roots : fallbackRoot ? [{ branch: '', name: fileName(fallbackRoot), root: fallbackRoot }] : [];
  return [...allRoots]
    .filter((root) => {
      const normalizedRoot = normalizeAbsolutePath(root.root);
      return normalizedPath === normalizedRoot
        || normalizedPath.startsWith(`${normalizedRoot}/`)
        || normalizedRoot.startsWith(`${normalizedPath}/`);
    })
    .sort((left, right) => rootPathMatchScore(right.root, normalizedPath) - rootPathMatchScore(left.root, normalizedPath))[0] ?? null;
}

function rootPathMatchScore(root: string, path: string) {
  const normalizedRoot = normalizeAbsolutePath(root);
  if (path === normalizedRoot) {
    return 1_000_000 + normalizedRoot.length;
  }
  if (path.startsWith(`${normalizedRoot}/`)) {
    return 800_000 + normalizedRoot.length;
  }
  if (normalizedRoot.startsWith(`${path}/`)) {
    return 600_000 - normalizedRoot.length;
  }
  return 0;
}

function rangeDescription(mode: GitRangeMode, rangePattern: string, rangePath: string, cwd: string | null) {
  if (mode === 'repo') {
    return '当前展示整个 Git 仓库的变更';
  }
  if (rangePattern.startsWith('__outside_git_root__/')) {
    return '该目录不在当前 Git 仓库内，请切换仓库或重新选择目录';
  }
  if (mode === 'cwd') {
    return rangePattern ? `仅展示会话目录：${rangePattern}` : `仅展示会话目录：${cwd ?? '未设置'}`;
  }
  return rangePattern ? `仅展示目录：${rangePattern}` : `仅展示目录：${rangePath || '未设置'}`;
}

function normalizePath(path: string) {
  return path.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function normalizeAbsolutePath(path: string) {
  return normalizePath(path);
}

function isAbsolutePath(path: string) {
  return path.startsWith('/');
}

function matchesPathFilter(path: string, prefs: GitPathFilterPrefs) {
  if (prefs.mode === 'code' && !isEngineeringCodePath(path)) {
    return false;
  }
  const includes = parsePathPatterns(prefs.includeText);
  const excludes = parsePathPatterns(prefs.excludeText);
  if (prefs.mode === 'custom' && includes.length > 0 && !includes.some((pattern) => pathMatchesPattern(path, pattern))) {
    return false;
  }
  if (prefs.mode === 'custom' && excludes.some((pattern) => pathMatchesPattern(path, pattern))) {
    return false;
  }
  return true;
}

function isEngineeringCodePath(path: string) {
  const name = path.split('/').pop() ?? path;
  if (DEFAULT_EXCLUDED_FILE_NAMES.has(name)) {
    return false;
  }
  if (DEFAULT_EXCLUDED_PATH_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix))) {
    return false;
  }
  if (DEFAULT_EXCLUDED_FILE_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
    return false;
  }
  if (CODE_FILE_NAMES.has(name)) {
    return true;
  }
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
  return CODE_EXTENSIONS.has(extension);
}

function parsePathPatterns(value: string) {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^\/+/, ''));
}

function pathMatchesPattern(path: string, pattern: string) {
  const normalized = pattern.replace(/^\/+/, '');
  if (!normalized) {
    return false;
  }
  if (normalized.endsWith('/')) {
    return path.startsWith(normalized);
  }
  return path === normalized || path.startsWith(`${normalized}/`) || path.includes(normalized);
}

function GitDiffText({ followLine, lines }: { followLine: number | null; lines: ParsedDiffLine[] }) {
  return (
    <>
      {lines.map((line, index) => (
        <span className={`${line.className} ${followLine !== null && line.newLine === followLine ? 'git-diff-follow-line' : ''}`} data-follow-line={followLine !== null && line.newLine === followLine ? 'true' : undefined} key={index}>
          <i className="git-diff-old-line">{line.oldLine ?? ''}</i>
          <i className="git-diff-new-line">{line.newLine ?? ''}</i>
          <b>{line.text || ' '}</b>
        </span>
      ))}
    </>
  );
}

function parseDiffLines(value: string): ParsedDiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  return value.split('\n').map((line) => {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { className: diffLineClass(line), oldLine: null, newLine: null, text: line };
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return { className: diffLineClass(line), oldLine: null, newLine: newLine++, text: line };
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      return { className: diffLineClass(line), oldLine: oldLine++, newLine: null, text: line };
    }
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) {
      return { className: diffLineClass(line), oldLine: null, newLine: null, text: line };
    }
    return { className: diffLineClass(line), oldLine: oldLine++, newLine: newLine++, text: line };
  });
}

function resolveFollowLocation(path: string, lines: ParsedDiffLine[]): GitFollowLocation | null {
  const firstAddedLine = lines.find((line) => line.text.startsWith('+') && !line.text.startsWith('+++') && line.newLine !== null);
  const firstChangedLine = firstAddedLine ?? lines.find((line) => line.text.startsWith('-') && !line.text.startsWith('---')) ?? null;
  if (!firstChangedLine) {
    return { hunk: '', line: null, path };
  }
  return {
    hunk: nearestHunk(lines, firstChangedLine) ?? '',
    line: firstChangedLine.newLine ?? firstChangedLine.oldLine,
    path,
  };
}

function nearestHunk(lines: ParsedDiffLine[], line: ParsedDiffLine) {
  const index = lines.indexOf(line);
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (lines[cursor].text.startsWith('@@')) {
      return lines[cursor].text;
    }
  }
  return null;
}

function diffLineClass(line: string) {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'git-diff-add';
  if (line.startsWith('-') && !line.startsWith('---')) return 'git-diff-del';
  if (line.startsWith('@@')) return 'git-diff-hunk';
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) return 'git-diff-meta';
  return 'git-diff-line';
}

function statusSignature(files: GitChangedFile[]) {
  return files
    .map((file) => `${file.path}:${file.status}:${file.modifiedMs ?? 0}`)
    .sort()
    .join('|');
}

function findLatestChangedFile(files: GitPanelFile[]) {
  return [...files]
    .filter((file) => matchesPathFilter(file.path, { excludeText: '', includeText: '', mode: 'code' }))
    .sort((left, right) => (right.modifiedMs ?? 0) - (left.modifiedMs ?? 0))[0]
    ?? [...files].sort((left, right) => (right.modifiedMs ?? 0) - (left.modifiedMs ?? 0))[0]
    ?? null;
}

function followStatusLabel(mode: GitFollowMode, paused: boolean) {
  if (mode === 'off') {
    return '实时跟随已关闭';
  }
  if (paused) {
    return '手动查看中';
  }
  return mode === 'notify' ? '只提醒最新变更' : '正在实时跟随';
}

function statusClass(status: string) {
  if (status === '??') return 'u';
  return status.toLowerCase();
}

function shortPath(path: string) {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || path;
}

function fileName(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function displayPathFromKey(key: string) {
  return key.split('::').slice(1).join('::') || key;
}

function topSegment(path: string) {
  return path.split('/').filter(Boolean)[0] ?? '根目录';
}

function pathWithoutFile(path: string) {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(0, index) : '根目录';
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatDiffPrompt(action: GitPromptAction, file: GitPanelFile, diff: string, status: GitStatusSummary | null) {
  const diffBlock = `仓库：${file.root ?? status?.root ?? '未知'}\n分支：${file.branch ?? status?.branch ?? '未知'}\n文件：${file.path}\n状态：${file.status}\n\n\`\`\`diff\n${diff}\n\`\`\``;
  if (action === 'explain') {
    return `请解释下面这个 Git Diff 的业务意图、关键改动和影响范围：\n\n${diffBlock}`;
  }
  if (action === 'review') {
    return `请对下面这个 Git Diff 做代码审查，重点看正确性、边界条件、性能、日志、可回滚性和测试建议：\n\n${diffBlock}`;
  }
  if (action === 'commit') {
    return `请根据下面这个 Git Diff 生成提交说明，包含一个简洁标题和 3 条变更要点：\n\n${diffBlock}`;
  }
  return diffBlock;
}
