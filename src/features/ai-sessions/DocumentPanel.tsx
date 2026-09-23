import { convertFileSrc } from '@tauri-apps/api/core';
import { Check, ChevronDown, ChevronRight, Copy, FileText, FolderOpen, Minus, Plus, RefreshCw, RotateCcw, Search, Star, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type WheelEvent } from 'react';
import { chooseDocumentDirectory, listDocumentTree, readDocumentFile, type DocumentFileContent, type DocumentNode } from './documentApi';

interface DocumentPanelProps {
  onCollapse: () => void;
  onError: (message: string) => void;
  onInsertText: (text: string) => void;
  onSnapshotChange?: (snapshot: DocumentSearchSnapshot) => void;
  openPathRequest?: string | null;
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);
const DOCUMENT_PANEL_STATE_KEY = 'agentbox.document-panel-state.v1';
const DOCUMENT_PANEL_FAVORITES_KEY = 'agentbox.document-panel-favorites.v1';
const ROOT_FAVORITE_PREFIX = '__root__:';
const DOCUMENT_TREE_MIN_WIDTH = 180;
const DOCUMENT_VIEWER_MIN_WIDTH = 280;
const DOCUMENT_TREE_RESIZE_DIVIDER_WIDTH = 8;
type ZoomPreview = { alt: string; src: string };
type TreeFilter = 'all' | 'open' | 'favorite';
type ContextMenuState = { node: DocumentNode; x: number; y: number } | null;
type SelectionContextMenuState = { text: string; x: number; y: number } | null;

const PDF_PREVIEW_BASE_WIDTH = 960;
const PDF_PREVIEW_BASE_HEIGHT = 640;

interface PersistedDocumentPanelState {
  rootPath: string;
  selectedPath: string | null;
  documentTreeCollapsed?: boolean;
  documentTreeWidth?: number;
  outlineOpen?: boolean;
  openedPaths?: string[];
  openPaths?: string[];
  treeFilter?: TreeFilter;
}

export interface DocumentSearchSnapshot {
  rootPath: string | null;
  nodes: DocumentNode[];
  openedFiles: DocumentFileContent[];
  selected: DocumentFileContent | null;
}

export function DocumentPanel({ onCollapse, onError, onInsertText, onSnapshotChange, openPathRequest }: DocumentPanelProps) {
  const initialPanelStateRef = useRef<PersistedDocumentPanelState | null>(loadDocumentPanelState());
  const [rootPath, setRootPath] = useState<string | null>(initialPanelStateRef.current?.rootPath ?? null);
  const [nodes, setNodes] = useState<DocumentNode[]>([]);
  const [keyword, setKeyword] = useState('');
  const [openPaths, setOpenPaths] = useState<Set<string>>(() => new Set(initialPanelStateRef.current?.openPaths ?? []));
  const [selected, setSelected] = useState<DocumentFileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [documentTreeCollapsed, setDocumentTreeCollapsed] = useState(initialPanelStateRef.current?.documentTreeCollapsed ?? false);
  const [documentTreeWidth, setDocumentTreeWidth] = useState<number | null>(initialPanelStateRef.current?.documentTreeWidth ?? null);
  const [openedFiles, setOpenedFiles] = useState<DocumentFileContent[]>([]);
  const [treeFilter, setTreeFilter] = useState<TreeFilter>(initialPanelStateRef.current?.treeFilter ?? 'all');
  const [favoritePaths, setFavoritePaths] = useState<Set<string>>(() => loadStringSet(DOCUMENT_PANEL_FAVORITES_KEY));
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [selectionContextMenu, setSelectionContextMenu] = useState<SelectionContextMenuState>(null);
  const [directoryMenuOpen, setDirectoryMenuOpen] = useState(false);
  const [fileActionMenuOpen, setFileActionMenuOpen] = useState(false);
  const [fileSearch, setFileSearch] = useState('');
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(initialPanelStateRef.current?.outlineOpen ?? true);
  const gestureStartZoom = useRef(1);
  const documentZoomRef = useRef(1);
  const appliedDocumentZoomRef = useRef(1);
  const documentZoomFrameRef = useRef<number | null>(null);
  const [documentPageZoom, setDocumentPageZoom] = useState(1);
  const documentPageZoomRef = useRef(1);
  const appliedDocumentPageZoomRef = useRef(1);
  const documentPageZoomFrameRef = useRef<number | null>(null);
  const documentBrowserRef = useRef<HTMLDivElement | null>(null);
  const documentContentRef = useRef<HTMLDivElement | null>(null);
  const fileSearchInputRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedPath = selected?.path ?? null;
  const rootFavoriteId = rootPath ? rootFavoriteKey(rootPath) : null;
  const rootFavorited = rootFavoriteId ? favoritePaths.has(rootFavoriteId) : false;
  const selectedOutline = useMemo(() => selected ? extractMarkdownOutline(selected.content) : [], [selected]);
  const fileSearchMatches = useMemo(() => selected ? computeNormalizedSearchRanges(selected.content, fileSearch) : [], [fileSearch, selected]);
  const visibleNodes = useMemo(() => {
    const filtered = filterNodesByMode(nodes, treeFilter, {
      favoritePaths,
      keyword: keyword.trim().toLowerCase(),
      openedPaths: new Set(openedFiles.map((file) => file.path)),
      rootFavoriteId,
    });
    return filtered;
  }, [favoritePaths, keyword, nodes, openedFiles, rootFavoriteId, treeFilter]);

  useEffect(() => {
    const state = initialPanelStateRef.current;
    if (!state?.rootPath) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    void loadDirectory(state.rootPath, state.selectedPath, {
      openedPaths: state.openedPaths,
      openPaths: state.openPaths,
      treeFilter: state.treeFilter,
    })
      .catch((error) => {
        if (!cancelled) {
          onError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(DOCUMENT_PANEL_FAVORITES_KEY, JSON.stringify([...favoritePaths]));
  }, [favoritePaths]);

  useEffect(() => {
    onSnapshotChange?.({ rootPath, nodes, openedFiles, selected });
  }, [nodes, onSnapshotChange, openedFiles, rootPath, selected]);

  useEffect(() => {
    if (!rootPath) {
      return;
    }
    saveDocumentPanelState({
      documentTreeCollapsed,
      documentTreeWidth: documentTreeWidth ?? undefined,
      openedPaths: openedFiles.map((file) => file.path),
      openPaths: [...openPaths],
      outlineOpen,
      rootPath,
      selectedPath,
      treeFilter,
    });
  }, [documentTreeCollapsed, openPaths, openedFiles, outlineOpen, rootPath, selectedPath, treeFilter]);

  useEffect(() => {
    const close = () => {
      setContextMenu(null);
      setSelectionContextMenu(null);
      setDirectoryMenuOpen(false);
      setFileActionMenuOpen(false);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && selected) {
        event.preventDefault();
        setFileSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selected]);

  useEffect(() => {
    if (!keyword.trim() && treeFilter !== 'favorite') {
      return;
    }
    setOpenPaths((current) => new Set([...current, ...collectDirectoryPaths(visibleNodes)]));
  }, [keyword, treeFilter, visibleNodes]);

  useEffect(() => {
    if (!selectedPath) {
      return;
    }
    setOpenPaths((current) => new Set([...current, ...ancestorDirectoryPaths(selectedPath)]));
  }, [selectedPath]);

  useEffect(() => {
    if (!openPathRequest || !rootPath) {
      return;
    }
    const node = findNode(nodes, openPathRequest);
    if (node?.kind !== 'file') {
      return;
    }
    void openFile(node);
  }, [nodes, openPathRequest, rootPath]);

  useEffect(() => {
    setFileSearch('');
    setActiveSearchIndex(0);
    setFileSearchOpen(false);
    setFileActionMenuOpen(false);
    setSelectionContextMenu(null);
  }, [selectedPath]);

  useEffect(() => {
    if (fileSearchOpen) {
      fileSearchInputRef.current?.focus();
    }
  }, [fileSearchOpen]);

  useEffect(() => {
    documentPageZoomRef.current = 1;
    appliedDocumentPageZoomRef.current = 1;
    setDocumentPageZoom(1);
  }, [selectedPath]);

  useEffect(() => {
    setActiveSearchIndex(0);
  }, [fileSearch]);

  useEffect(() => {
    if (!fileSearchMatches.length) {
      return;
    }
    const active = documentContentRef.current?.querySelector('.document-search-hit.active');
    if (active instanceof HTMLElement && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }, [activeSearchIndex, fileSearchMatches, fileSearchOpen]);

  useEffect(() => {
    const browser = documentBrowserRef.current;
    if (!browser) {
      return;
    }

    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStartZoom.current = documentZoomRef.current;
    };
    const handleGestureChange = (event: Event) => {
      event.preventDefault();
      const gestureEvent = event as unknown as { scale?: unknown };
      const scale = typeof gestureEvent.scale === 'number' ? gestureEvent.scale : 1;
      const next = clampZoom(Number((gestureStartZoom.current * scale).toFixed(2)));
      adjustDocumentZoomTo(next, documentContentRef.current);
    };

    browser.addEventListener('gesturestart', handleGestureStart);
    browser.addEventListener('gesturechange', handleGestureChange);
    return () => {
      browser.removeEventListener('gesturestart', handleGestureStart);
      browser.removeEventListener('gesturechange', handleGestureChange);
      if (documentZoomFrameRef.current !== null) {
        window.cancelAnimationFrame(documentZoomFrameRef.current);
        documentZoomFrameRef.current = null;
      }
      if (documentPageZoomFrameRef.current !== null) {
        window.cancelAnimationFrame(documentPageZoomFrameRef.current);
        documentPageZoomFrameRef.current = null;
      }
    };
  }, []);

  async function loadDirectory(selectedRoot: string, selectedPath: string | null = null, options: { preserveOpenPaths?: boolean; openedPaths?: string[]; openPaths?: string[]; treeFilter?: TreeFilter } = {}) {
    const tree = await listDocumentTree(selectedRoot);
    setRootPath(selectedRoot);
    setNodes(tree);
    if (options.treeFilter) {
      setTreeFilter(options.treeFilter);
    }
    setOpenPaths((current) => {
      if (options.openPaths) {
        return preserveExistingOpenPaths(new Set(options.openPaths), tree);
      }
      return options.preserveOpenPaths ? preserveExistingOpenPaths(current, tree) : new Set(collectTopLevelDirectoryPaths(tree));
    });
    const restoredFiles = await restoreOpenedFiles(selectedRoot, tree, options.openedPaths);
    if (restoredFiles.length > 0) {
      setOpenedFiles(restoredFiles);
    } else if (!selectedPath) {
      setOpenedFiles([]);
    }
    if (selectedPath) {
      const file = findNode(tree, selectedPath);
      if (file?.kind === 'file') {
        const selectedFile = restoredFiles.find((item) => item.path === file.path) ?? await readDocumentFile(selectedRoot, file.path);
        activateFile(selectedFile);
        saveDocumentPanelState({ rootPath: selectedRoot, selectedPath: file.path });
        return;
      }
    }
    setSelected(null);
    saveDocumentPanelState({ rootPath: selectedRoot, selectedPath: null });
  }

  async function chooseRoot() {
    try {
      const selectedRoot = await chooseDocumentDirectory();
      if (!selectedRoot) {
        return;
      }
      setLoading(true);
      setOpenedFiles([]);
      setSelected(null);
      setTreeFilter('all');
      setDocumentTreeCollapsed(false);
      setOutlineOpen(true);
      await loadDirectory(selectedRoot);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function refreshDirectory() {
    if (!rootPath) {
      return;
    }
    try {
      setLoading(true);
      await loadDirectory(rootPath, selected?.path ?? null, { preserveOpenPaths: true });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function openFile(node: DocumentNode) {
    if (!rootPath || node.kind !== 'file') {
      return;
    }
    try {
      const content = await readDocumentFile(rootPath, node.path);
      activateFile(content);
      saveDocumentPanelState({ rootPath, selectedPath: node.path });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }


  function activateFile(content: DocumentFileContent) {
    setSelected(content);
    setOpenedFiles((current) => [content, ...current.filter((file) => file.path !== content.path)].slice(0, 8));
  }

  function closeTab(path: string) {
    setOpenedFiles((current) => {
      const next = current.filter((file) => file.path !== path);
      if (selected?.path === path) {
        setSelected(next[0] ?? null);
        if (rootPath) {
          saveDocumentPanelState({ rootPath, selectedPath: next[0]?.path ?? null });
        }
      }
      return next;
    });
  }

  function toggleFavorite(path: string) {
    setFavoritePaths((current) => toggleStringInSet(current, path));
  }

  function toggleRootFavorite() {
    if (!rootFavoriteId) return;
    setFavoritePaths((current) => toggleStringInSet(current, rootFavoriteId));
  }

  function runDirectoryMenuAction(action: () => void | Promise<void>) {
    setDirectoryMenuOpen(false);
    void action();
  }

  function runFileAction(action: () => void | Promise<void>) {
    setFileActionMenuOpen(false);
    void action();
  }

  function focusNextSearchResult() {
    if (!fileSearchMatches.length) {
      return;
    }
    setActiveSearchIndex((current) => (current + 1) % fileSearchMatches.length);
  }

  function handleFileSearchKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      setFileSearchOpen(false);
      return;
    }
    if (event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    focusNextSearchResult();
  }

  function insertSelectedWithPath() {
    const text = getSelectedText();
    if (text) {
      insertSelectedWithPathText(text);
    }
  }

  function insertSelectedWithPathText(text: string) {
    if (!selected) return;
    onInsertText(`文件：${selected.path}

选中内容：
${text}`);
  }

  function handleDocumentContentContextMenu(event: MouseEvent<HTMLDivElement>) {
    const text = getSelectedText();
    if (!text) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setSelectionContextMenu({ text, x: event.clientX, y: event.clientY });
  }

  function insertContextPrompt() {
    if (!selected) return;
    const text = window.getSelection()?.toString().trim() || selected.content.slice(0, 4000);
    onInsertText(`请结合当前文件、选中内容和目录上下文分析：

当前文件：${selected.path}

目录上下文：
${buildTreeContext(nodes)}

内容：
${text}`);
  }

  function runFilePrompt(kind: 'explain' | 'summary' | 'risk' | 'todo', node: DocumentNode) {
    const templates = {
      explain: `请阅读并解释这个文件的职责、关键逻辑和调用关系：${node.path}`,
      summary: `请总结这个文件的核心内容，并按要点输出：${node.path}`,
      risk: `请分析这个文件可能存在的风险点、边界条件和测试建议：${node.path}`,
      todo: `请基于这个文件生成后续待办清单，按优先级排序：${node.path}`,
    };
    onInsertText(templates[kind]);
    setContextMenu(null);
  }

  function copyText(text: string, label = '已复制') {
    void Promise.resolve(navigator.clipboard?.writeText(text)).catch(() => undefined);
    onError(label);
  }

  function adjustDocumentZoomTo(nextZoom: number, container: HTMLDivElement | null = documentContentRef.current) {
    const next = clampZoom(nextZoom);
    if (!container || next === documentZoomRef.current) {
      return;
    }
    documentZoomRef.current = next;
    scheduleDocumentZoom(container);
  }

  function adjustDocumentZoom(delta: number, container: HTMLDivElement | null = documentContentRef.current) {
    adjustDocumentZoomTo(Number((documentZoomRef.current + delta).toFixed(2)), container);
  }

  function adjustDocumentPageZoomTo(nextZoom: number, container: HTMLDivElement | null = documentContentRef.current) {
    const next = clampPageZoom(nextZoom);
    if (next === documentPageZoomRef.current) {
      return;
    }
    documentPageZoomRef.current = next;
    setDocumentPageZoom(next);
    if (container) {
      scheduleDocumentPageZoom(container);
    }
  }

  function adjustDocumentPageZoom(delta: number, container: HTMLDivElement | null = documentContentRef.current) {
    adjustDocumentPageZoomTo(Number((documentPageZoomRef.current + delta).toFixed(2)), container);
  }

  function scheduleDocumentZoom(container: HTMLDivElement) {
    if (documentZoomFrameRef.current !== null) {
      return;
    }
    documentZoomFrameRef.current = window.requestAnimationFrame(() => {
      documentZoomFrameRef.current = null;
      const current = appliedDocumentZoomRef.current;
      const next = documentZoomRef.current;
      const preview = container.querySelector<HTMLElement>('.document-preview-content');
      if (!preview || next === current) {
        return;
      }
      const ratio = next / current;
      const centerX = container.scrollLeft + container.clientWidth / 2;
      const centerY = container.scrollTop + container.clientHeight / 2;
      preview.style.setProperty('--document-content-zoom', String(next));
      appliedDocumentZoomRef.current = next;
      container.scrollLeft = Math.max(0, centerX * ratio - container.clientWidth / 2);
      container.scrollTop = Math.max(0, centerY * ratio - container.clientHeight / 2);
    });
  }

  function scheduleDocumentPageZoom(container: HTMLDivElement) {
    if (documentPageZoomFrameRef.current !== null) {
      return;
    }
    documentPageZoomFrameRef.current = window.requestAnimationFrame(() => {
      documentPageZoomFrameRef.current = null;
      const current = appliedDocumentPageZoomRef.current;
      const next = documentPageZoomRef.current;
      const preview = container.querySelector<HTMLElement>('.document-page-preview');
      if (!preview || next === current) {
        return;
      }
      const ratio = next / current;
      const centerX = container.scrollLeft + container.clientWidth / 2;
      const centerY = container.scrollTop + container.clientHeight / 2;
      preview.style.setProperty('--document-page-zoom', String(next));
      appliedDocumentPageZoomRef.current = next;
      container.scrollLeft = Math.max(0, centerX * ratio - container.clientWidth / 2);
      container.scrollTop = Math.max(0, centerY * ratio - container.clientHeight / 2);
    });
  }

  function handleDocumentWheel(event: WheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const previewKind = selected ? selected.previewKind ?? inferPreviewKind(selected.extension) : null;
    if (isWholeDocumentPreviewKind(previewKind)) {
      adjustDocumentPageZoom(event.deltaY < 0 ? 0.1 : -0.1, event.currentTarget);
      return;
    }
    adjustDocumentZoom(event.deltaY < 0 ? 0.08 : -0.08, event.currentTarget);
  }

  function toggleDirectory(path: string) {
    setOpenPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function startDocumentTreeResize(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const divider = event.currentTarget;
    const pointerId = event.pointerId;
    const browser = documentBrowserRef.current;
    const tree = divider.previousElementSibling;
    const startX = event.clientX;
    const measuredTreeWidth = tree instanceof HTMLElement ? tree.getBoundingClientRect().width : 0;
    const currentTreeWidth = documentTreeWidth
      ?? (measuredTreeWidth || DOCUMENT_TREE_MIN_WIDTH);
    const browserWidth = browser?.getBoundingClientRect().width
      || browser?.clientWidth
      || window.innerWidth;
    const maxTreeWidth = Math.max(
      DOCUMENT_TREE_MIN_WIDTH,
      browserWidth - DOCUMENT_TREE_RESIZE_DIVIDER_WIDTH - DOCUMENT_VIEWER_MIN_WIDTH,
    );

    divider.setPointerCapture(pointerId);
    divider.classList.add('active');
    document.body.classList.add('resizing-document-tree');

    const move = (moveEvent: globalThis.PointerEvent) => {
      setDocumentTreeWidth(clampDocumentTreeWidth(
        currentTreeWidth + moveEvent.clientX - startX,
        maxTreeWidth,
      ));
    };
    const up = (upEvent: globalThis.PointerEvent) => {
      divider.releasePointerCapture(upEvent.pointerId);
      divider.classList.remove('active');
      document.body.classList.remove('resizing-document-tree');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const selectedPreviewKind = selected ? selected.previewKind ?? inferPreviewKind(selected.extension) : null;
  const wholeDocumentZoomEnabled = isWholeDocumentPreviewKind(selectedPreviewKind);
  const documentBrowserStyle = documentTreeWidth === null
    ? undefined
    : { '--document-tree-width': `${documentTreeWidth}px` } as CSSProperties;

  return (
    <aside className="document-panel">
      <header className="document-panel-header">
        <div className="document-panel-title">
          <strong>文档目录</strong>
          <span>{rootPath ?? '选择本地目录后查看文件'}</span>
        </div>
        <div className="document-header-actions">
          <div className="document-directory-menu-wrap" onClick={(event) => event.stopPropagation()}>
            <button
              aria-expanded={directoryMenuOpen}
              aria-haspopup="menu"
              className={directoryMenuOpen ? 'document-directory-menu-trigger active' : 'document-directory-menu-trigger'}
              onClick={() => setDirectoryMenuOpen((value) => !value)}
              type="button"
            >
              目录操作
              <ChevronDown size={14} />
            </button>
            {directoryMenuOpen && (
              <div aria-label="目录操作" className="document-directory-menu" role="menu">
                <span className="document-menu-section-title">目录动作</span>
                <button disabled={loading} onClick={() => runDirectoryMenuAction(chooseRoot)} role="menuitem" type="button">
                  <FolderOpen size={14} />
                  选择目录
                </button>
                <button disabled={!rootPath} onClick={() => runDirectoryMenuAction(toggleRootFavorite)} role="menuitem" type="button">
                  <Star size={14} />
                  {rootFavorited ? '取消收藏当前目录' : '收藏当前目录'}
                </button>
                <span className="document-menu-divider" />
                <span className="document-menu-section-title">筛选</span>
                {(['all', 'open', 'favorite'] as TreeFilter[]).map((mode) => (
                  <button
                    aria-checked={treeFilter === mode}
                    className={treeFilter === mode ? 'active' : ''}
                    key={mode}
                    onClick={() => runDirectoryMenuAction(() => setTreeFilter(mode))}
                    role="menuitemradio"
                    type="button"
                  >
                    {treeFilterLabel(mode)}
                  </button>
                ))}
                <span className="document-menu-divider" />
                <span className="document-menu-section-title">刷新</span>
                <button disabled={!rootPath || loading} onClick={() => runDirectoryMenuAction(refreshDirectory)} role="menuitem" type="button">
                  <RefreshCw size={14} />
                  刷新目录
                </button>
              </div>
            )}
          </div>
          <button aria-label="收起文档目录" className="icon-button" onClick={onCollapse} title="收起文档目录" type="button">
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="document-actions">
        <label className="document-search">
          <Search size={14} />
          <input aria-label="搜索文档" onChange={(event) => setKeyword(event.target.value)} placeholder="搜索文件或路径" type="search" value={keyword} />
        </label>
        <button className="document-tree-toggle" onClick={() => setDocumentTreeCollapsed((value) => !value)} type="button">
          {documentTreeCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          {documentTreeCollapsed ? '展开目录树' : '收起目录树'}
        </button>
      </div>

      <div aria-label="文档浏览器" className={documentTreeCollapsed ? 'document-browser tree-collapsed' : 'document-browser'} onWheel={handleDocumentWheel} ref={documentBrowserRef} style={documentBrowserStyle}>
        {!documentTreeCollapsed && <nav aria-label="文档树" className="document-tree horizontal-scroll-tree">
          {!rootPath && <p className="empty">尚未选择目录</p>}
          {rootPath && visibleNodes.length === 0 && <p className="empty">没有匹配的文档</p>}
          {visibleNodes.map((node) => (
            <DocumentTreeNode
              key={node.path}
              node={node}
              favoritePaths={favoritePaths}
              keyword={keyword.trim()}
              onContextMenu={(node, event) => { event.preventDefault(); setContextMenu({ node, x: event.clientX, y: event.clientY }); }}
              onOpenFile={openFile}
              onToggleDirectory={toggleDirectory}
              openPaths={openPaths}
              selectedPath={selected?.path ?? null}
            />
          ))}
        </nav>}

        {!documentTreeCollapsed && (
          <div
            aria-label="调整目录列表宽度"
            aria-orientation="vertical"
            className="document-tree-resize-divider"
            onPointerDown={startDocumentTreeResize}
            role="separator"
          />
        )}

        {contextMenu && (
          <DocumentContextMenu
            favorite={favoritePaths.has(contextMenu.node.path)}
            menu={contextMenu}
            onCopy={(value) => copyText(value)}
            onCopyFull={(node) => copyText(fullDocumentPath(rootPath, node.path))}
            onRunPrompt={runFilePrompt}
            onToggleFavorite={() => toggleFavorite(contextMenu.node.path)}
          />
        )}

        <article className="document-viewer">
          {selected ? (
            <>
              <div className="document-viewer-header sticky-file-toolbar compact-file-toolbar">
                {openedFiles.length > 0 && (
                  <div aria-label="已打开文件" className="document-tabs horizontal-document-tabs">
                    {openedFiles.map((file) => (
                      <button className={file.path === selected.path ? 'active' : ''} key={file.path} onClick={() => setSelected(file)} type="button">
                        <span>{file.name}</span>
                        <X aria-label={`关闭 ${file.name}`} onClick={(event) => { event.stopPropagation(); closeTab(file.path); }} size={12} />
                      </button>
                    ))}
                  </div>
                )}
                <div className="document-file-toolbar-row">
                  <div>
                    <strong>{selected.name}</strong>
                    <span>{fileTypeLabel(selected.extension)} · {formatBytes(selected.size)}</span>
                  </div>
                  <div className="document-file-actions">
                    {fileSearchOpen && (
                      <div aria-label="文件搜索" className="document-file-search">
                        <Search size={13} />
                        <textarea
                          autoFocus
                          id="document-file-search"
                          aria-label="搜索当前文件"
                          onChange={(event) => setFileSearch(event.target.value)}
                          onKeyDown={handleFileSearchKeyDown}
                          placeholder="搜索当前文件"
                          ref={fileSearchInputRef}
                          rows={1}
                          value={fileSearch}
                        />
                        <span aria-label="搜索结果数量" className="document-file-search-count">
                          {fileSearch.trim() ? `${fileSearchMatches.length ? activeSearchIndex + 1 : 0}/${fileSearchMatches.length}` : '0/0'}
                        </span>
                        <button aria-label="关闭文件搜索" className="document-file-search-close" onClick={() => setFileSearchOpen(false)} title="关闭搜索" type="button">
                          <X size={16} strokeWidth={2.25} />
                        </button>
                      </div>
                    )}
                    <button className="document-outline-toggle" onClick={() => setOutlineOpen((value) => !value)} type="button">{outlineOpen ? '隐藏大纲' : '显示大纲'}</button>
                    {wholeDocumentZoomEnabled && (
                      <DocumentPageZoomControls onAdjust={adjustDocumentPageZoom} onReset={() => adjustDocumentPageZoomTo(1)} zoom={documentPageZoom} />
                    )}
                    <div className="document-file-action-menu-wrap" onClick={(event) => event.stopPropagation()}>
                      <button aria-expanded={fileActionMenuOpen} aria-haspopup="menu" className={fileActionMenuOpen ? 'document-file-action-trigger active' : 'document-file-action-trigger'} onMouseDown={(event) => event.preventDefault()} onClick={() => setFileActionMenuOpen((value) => !value)} type="button">
                        文件操作
                        <ChevronDown size={14} />
                      </button>
                      {fileActionMenuOpen && (
                        <div aria-label="文件操作" className="document-file-action-menu" role="menu">
                          <button onClick={() => runFileAction(() => toggleFavorite(selected.path))} role="menuitem" type="button">{favoritePaths.has(selected.path) ? '取消收藏' : '收藏'}</button>
                          <button onMouseDown={(event) => event.preventDefault()} onClick={() => runFileAction(() => insertSelectedText(onInsertText))} role="menuitem" type="button">插入选中</button>
                          <button onClick={() => runFileAction(() => onInsertText(`请阅读 ${selected.path}，并结合当前会话给出结论。`))} role="menuitem" type="button">插入引用</button>
                          <button onMouseDown={(event) => event.preventDefault()} onClick={() => runFileAction(insertSelectedWithPath)} role="menuitem" type="button">带路径插入</button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              <div aria-label="文档内容滚动区" className="document-viewer-body" onContextMenu={handleDocumentContentContextMenu} onWheel={handleDocumentWheel} ref={documentContentRef}>
                <div className={outlineOpen && selectedOutline.length > 0 ? 'document-content-layout with-outline' : 'document-content-layout'}>
                  {outlineOpen && selectedOutline.length > 0 && (
                    <nav aria-label="Markdown 大纲" className="document-outline independent-scroll-outline">
                      {selectedOutline.map((item) => <a href={`#${item.id}`} key={item.id} style={{ paddingLeft: `${(item.level - 1) * 10}px` }}>{item.title}</a>)}
                    </nav>
                  )}
                  <DocumentPreview activeSearchIndex={activeSearchIndex} documentPageZoom={documentPageZoom} documentZoom={documentZoomRef.current} file={selected} rootPath={rootPath} searchTerm={fileSearch} />
                </div>
                {selectionContextMenu && (
                  <DocumentSelectionContextMenu
                    menu={selectionContextMenu}
                    onInsert={() => onInsertText(selectionContextMenu.text)}
                    onInsertWithPath={() => insertSelectedWithPathText(selectionContextMenu.text)}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="document-empty">
              <FileText size={28} />
              <span>选择左侧文件查看内容</span>
            </div>
          )}
        </article>
      </div>
    </aside>
  );
}

function clampZoom(value: number) {
  return Math.min(2.2, Math.max(0.85, value));
}

function clampPageZoom(value: number) {
  return Math.min(2, Math.max(0.6, value));
}

function isWholeDocumentPreviewKind(kind: NonNullable<DocumentFileContent['previewKind']> | null) {
  return kind === 'docx' || kind === 'pdf' || kind === 'office-html';
}

function formatPageZoom(value: number) {
  return `${Math.round(value * 100)}%`;
}

function DocumentPageZoomControls({ onAdjust, onReset, zoom }: { onAdjust: (delta: number) => void; onReset: () => void; zoom: number }) {
  return (
    <div aria-label="文档整体缩放" className="document-page-zoom-controls" role="group">
      <span className="document-page-zoom-label">整体</span>
      <button aria-label="缩小文档" disabled={zoom <= 0.6} onClick={() => onAdjust(-0.1)} title="缩小文档" type="button">
        <Minus size={13} />
      </button>
      <span aria-label={`当前文档缩放 ${formatPageZoom(zoom)}`} className="document-page-zoom-value">
        {formatPageZoom(zoom)}
      </span>
      <button aria-label="放大文档" disabled={zoom >= 2} onClick={() => onAdjust(0.1)} title="放大文档" type="button">
        <Plus size={13} />
      </button>
      <button aria-label="重置文档缩放" className="document-page-zoom-reset" onClick={onReset} title="重置为 100%" type="button">
        <RotateCcw size={13} />
      </button>
    </div>
  );
}

function DocumentTreeNode({ favoritePaths, keyword, node, onContextMenu, onOpenFile, onToggleDirectory, openPaths, selectedPath }: {
  favoritePaths: Set<string>;
  keyword: string;
  node: DocumentNode;
  onContextMenu: (node: DocumentNode, event: MouseEvent) => void;
  onOpenFile: (node: DocumentNode) => void;
  onToggleDirectory: (path: string) => void;
  openPaths: Set<string>;
  selectedPath: string | null;
}) {
  if (node.kind === 'directory') {
    const open = openPaths.has(node.path);
    return (
      <div className="document-tree-group">
        <button aria-expanded={open} className="document-tree-item directory" onContextMenu={(event) => onContextMenu(node, event)} onClick={() => onToggleDirectory(node.path)} type="button">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>{highlightText(node.name, keyword)}</span>
          {favoritePaths.has(node.path) && <Star className="favorite-mark" size={12} />}
        </button>
        {open && (node.children ?? []).map((child) => (
          <div className="document-tree-child" key={child.path}>
            <DocumentTreeNode favoritePaths={favoritePaths} keyword={keyword} node={child} onContextMenu={onContextMenu} onOpenFile={onOpenFile} onToggleDirectory={onToggleDirectory} openPaths={openPaths} selectedPath={selectedPath} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <button className={node.path === selectedPath ? 'document-tree-item file active' : 'document-tree-item file'} onContextMenu={(event) => onContextMenu(node, event)} onClick={() => void onOpenFile(node)} type="button">
      <FileText size={14} />
      <span>{highlightText(node.name, keyword)}</span>
      {favoritePaths.has(node.path) && <Star className="favorite-mark" size={12} />}
    </button>
  );
}

function DocumentPreview({ activeSearchIndex, documentPageZoom, documentZoom, file, rootPath, searchTerm }: { activeSearchIndex: number; documentPageZoom: number; documentZoom: number; file: DocumentFileContent; rootPath: string | null; searchTerm: string }) {
  const [zoomPreview, setZoomPreview] = useState<ZoomPreview | null>(null);
  const previewStyle = { '--document-content-zoom': documentZoom, '--document-page-zoom': documentPageZoom } as CSSProperties;
  const previewKind = file.previewKind ?? inferPreviewKind(file.extension);

  if (previewKind === 'docx') {
    return <DocxPreview file={file} previewStyle={previewStyle} />;
  }
  if (previewKind === 'pdf' || previewKind === 'image') {
    return <BinaryDocumentPreview documentPageZoom={documentPageZoom} file={file} kind={previewKind} previewStyle={previewStyle} />;
  }
  if (previewKind === 'office-html') {
    return <OfficeHtmlPreview file={file} previewStyle={previewStyle} />;
  }
  if (previewKind === 'markdown' || MARKDOWN_EXTENSIONS.has(file.extension.toLowerCase())) {
    return (
      <>
        <div aria-label="文档内容缩放区" className="document-preview-zoom document-preview-content" style={previewStyle}>
          <div aria-label="Markdown 渲染内容" className="document-markdown">{renderMarkdown(file.content, file, rootPath, setZoomPreview, searchTerm, activeSearchIndex)}</div>
        </div>
        {zoomPreview && (
          <div aria-label="图片预览" className="document-image-lightbox" role="dialog">
            <button aria-label="关闭图片预览" className="document-image-lightbox-close" onClick={() => setZoomPreview(null)} type="button">关闭</button>
            <img alt={`${zoomPreview.alt} 放大预览`} src={zoomPreview.src} />
          </div>
        )}
      </>
    );
  }
  return <div aria-label="文档内容缩放区" className="document-preview-zoom document-preview-content" style={previewStyle}><CodePreview activeSearchIndex={activeSearchIndex} content={file.content} extension={file.extension} searchTerm={searchTerm} /></div>;
}

function DocxPreview({ file, previewStyle }: { file: DocumentFileContent; previewStyle: CSSProperties }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const styleRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const body = bodyRef.current;
    const style = styleRef.current;
    if (!body || !file.binary?.length) {
      setError('无法读取 Word 文档内容');
      return;
    }
    let cancelled = false;
    body.replaceChildren();
    style?.replaceChildren();
    setError(null);
    const blob = new Blob([new Uint8Array(file.binary)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    void import('docx-preview')
      .then(({ renderAsync }) => renderAsync(blob, body, style ?? undefined, {
        breakPages: true,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        useBase64URL: true,
      }))
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'Word 文档渲染失败');
        }
      });
    return () => {
      cancelled = true;
      body.replaceChildren();
      style?.replaceChildren();
    };
  }, [file]);

  return (
    <div aria-label="文档内容缩放区" className="document-preview-zoom document-preview-content document-page-preview" style={previewStyle}>
      <div className="document-page-stage">
        <div className="document-page-scale">
          <div aria-label="Word 文档预览" className="document-docx-preview">
            {error ? <div className="document-preview-error">{error}</div> : <><div ref={styleRef} /><div ref={bodyRef} /></>}
          </div>
        </div>
      </div>
    </div>
  );
}

function BinaryDocumentPreview({ documentPageZoom, file, kind, previewStyle }: { documentPageZoom: number; file: DocumentFileContent; kind: 'pdf' | 'image'; previewStyle: CSSProperties }) {
  const url = useBinaryPreviewUrl(file);
  if (!url) {
    return <div aria-label="文档内容缩放区" className="document-preview-zoom document-preview-content" style={previewStyle}><div className="document-preview-error">无法读取文件内容</div></div>;
  }
  if (kind === 'pdf') {
    return (
      <div aria-label="文档内容缩放区" className="document-preview-zoom document-preview-content document-page-preview" style={previewStyle}>
        <div className="document-page-stage">
          <div className="document-page-scale document-pdf-page-scale">
            <iframe
              aria-label="PDF 文档预览"
              className="document-pdf-preview"
              height={Math.round(PDF_PREVIEW_BASE_HEIGHT * documentPageZoom)}
              src={url}
              style={{
                height: `${Math.round(PDF_PREVIEW_BASE_HEIGHT * documentPageZoom)}px`,
                minHeight: 0,
                minWidth: 0,
                width: `${Math.round(PDF_PREVIEW_BASE_WIDTH * documentPageZoom)}px`,
              }}
              title={`${file.name} PDF 预览`}
              width={Math.round(PDF_PREVIEW_BASE_WIDTH * documentPageZoom)}
            />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div aria-label="文档内容缩放区" className="document-preview-zoom document-preview-content document-image-preview" style={previewStyle}>
      <img alt={file.name} className="document-binary-image" src={url} />
    </div>
  );
}

function OfficeHtmlPreview({ file, previewStyle }: { file: DocumentFileContent; previewStyle: CSSProperties }) {
  if (!file.renderedHtml) {
    return <div aria-label="文档内容缩放区" className="document-preview-zoom document-preview-content" style={previewStyle}><div className="document-preview-error">该 Office 文档无法转换为预览内容</div></div>;
  }
  return (
    <div aria-label="文档内容缩放区" className="document-preview-zoom document-preview-content document-page-preview" style={previewStyle}>
      <div className="document-page-stage">
        <div className="document-page-scale">
          <iframe aria-label="Office 文档预览" className="document-office-preview" sandbox="" srcDoc={file.renderedHtml} title={`${file.name} Office 预览`} />
        </div>
      </div>
    </div>
  );
}

function useBinaryPreviewUrl(file: DocumentFileContent) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.binary?.length) {
      setUrl(null);
      return;
    }
    const mime = mimeTypeForDocument(file.extension);
    const blob = new Blob([new Uint8Array(file.binary)], { type: mime });
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return url;
}

function inferPreviewKind(extension: string): NonNullable<DocumentFileContent['previewKind']> {
  const lower = extension.toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(lower)) return 'markdown';
  if (lower === 'docx' || lower === 'doc') return 'docx';
  if (['rtf', 'odt', 'ods', 'odp'].includes(lower)) return 'office-html';
  if (lower === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(lower)) return 'image';
  return 'text';
}

function mimeTypeForDocument(extension: string) {
  const lower = extension.toLowerCase();
  if (lower === 'pdf') return 'application/pdf';
  if (lower === 'svg') return 'image/svg+xml';
  if (lower === 'jpg' || lower === 'jpeg') return 'image/jpeg';
  if (lower === 'gif') return 'image/gif';
  return 'image/png';
}

function renderMarkdown(content: string, file: DocumentFileContent, rootPath: string | null, onZoomPreview: (preview: ZoomPreview) => void, searchTerm = '', activeSearchIndex = 0) {
  const searchState = createSearchRenderState(activeSearchIndex);
  const lines = content.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```(.*)$/);
    if (fence) {
      const language = fence[1].trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push(
        language.toLowerCase() === 'mermaid'
          ? <MermaidDiagram chart={code.join('\n')} key={`mermaid-${index}`} />
          : (
            <pre className="document-markdown-code" key={`code-${index}`}>
              {language && <span className="document-markdown-code-lang">{language}</span>}
              <code>{renderHighlightedCode(code.join('\n'), language, searchTerm, searchState)}</code>
            </pre>
          ),
      );
      continue;
    }

    const image = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image) {
      const alt = image[1] || '图片';
      const src = resolveMarkdownAsset(rootPath, file.path, image[2]);
      blocks.push(<MarkdownImage alt={alt} key={`img-${index}`} onZoomImage={onZoomPreview} src={src} />);
      index += 1;
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const tableLines: string[] = [];
      while (index < lines.length && isMarkdownTableRow(lines[index])) {
        tableLines.push(lines[index].trim());
        index += 1;
      }
      blocks.push(<MarkdownTable key={`table-${index}`} lines={tableLines} />);
      continue;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    if (unordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].trim().match(/^[-*+]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push(<ul className="document-markdown-list" key={`ul-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item, searchTerm, searchState)}</li>)}</ul>);
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].trim().match(/^\d+[.)]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push(<ol className="document-markdown-list" key={`ol-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item, searchTerm, searchState)}</li>)}</ol>);
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quote.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(<blockquote className="document-markdown-quote" key={`quote-${index}`}>{quote.map((item, itemIndex) => <p key={itemIndex}>{renderInlineMarkdown(item, searchTerm, searchState)}</p>)}</blockquote>);
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      blocks.push(<hr className="document-markdown-rule" key={`hr-${index}`} />);
      index += 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const headingText = heading[2];
      const headingId = headingIdFor(headingText, index);
      const content = renderInlineMarkdown(headingText, searchTerm, searchState);
      if (level === 1) blocks.push(<h1 id={headingId} key={`h-${index}`}>{content}</h1>);
      else if (level === 2) blocks.push(<h2 id={headingId} key={`h-${index}`}>{content}</h2>);
      else blocks.push(<h3 id={headingId} key={`h-${index}`}>{content}</h3>);
      index += 1;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index].trim();
      if (!current || /^```/.test(current) || /^[-*+]\s+/.test(current) || /^\d+[.)]\s+/.test(current) || current.startsWith('>') || /^(#{1,6})\s+/.test(current) || /^---+$/.test(current) || /^!\[[^\]]*\]\([^)]+\)$/.test(current) || isMarkdownTableStart(lines, index)) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push(<p key={`p-${index}`}>{renderInlineMarkdown(paragraph.join(' '), searchTerm, searchState)}</p>);
  }

  return blocks;
}



function MarkdownImage({ alt, onZoomImage, src }: { alt: string; onZoomImage: (image: { alt: string; src: string }) => void; src: string }) {
  return (
    <figure className="document-markdown-image">
      <button aria-label={`放大图片：${alt}`} onClick={() => onZoomImage({ alt, src })} type="button">
        <img alt={alt} src={src} />
      </button>
      {alt && <figcaption>{alt}</figcaption>}
    </figure>
  );
}

function CodePreview({ activeSearchIndex, content, extension, searchTerm }: { activeSearchIndex: number; content: string; extension: string; searchTerm: string }) {
  const searchState = createSearchRenderState(activeSearchIndex);
  const lower = extension.toLowerCase();
  if (lower === 'json') {
    return <JsonPreview searchState={searchState} content={content} searchTerm={searchTerm} />;
  }
  return (
    <pre className={`document-code syntax-${lower || 'text'}`}>
      <code>{renderCodeLines(content, extension, searchTerm, searchState)}</code>
    </pre>
  );
}

function JsonPreview({ content, searchState, searchTerm }: { content: string; searchState: SearchRenderState; searchTerm: string }) {
  try {
    const parsed = JSON.parse(content);
    const pretty = JSON.stringify(parsed, null, 2);
    return (
      <details className="document-json-preview" open>
        <summary>JSON 格式化视图</summary>
        <button onClick={() => void navigator.clipboard?.writeText('$')} type="button">复制 path: $</button>
        <pre className="document-code syntax-json"><code>{renderCodeLines(pretty, 'json', searchTerm, searchState)}</code></pre>
      </details>
    );
  } catch {
    return <pre className="document-code syntax-json"><code>{renderCodeLines(content, 'json', searchTerm, searchState)}</code></pre>;
  }
}

function renderCodeLines(content: string, language: string, searchTerm = '', searchState?: SearchRenderState) {
  const ranges = computeNormalizedSearchRanges(content, searchTerm);
  let offset = 0;
  return content.split('\n').map((line, index) => {
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    const lineRanges = ranges
      .map((range) => ({ hitIndex: range.hitIndex, start: Math.max(0, range.start - lineStart), end: Math.min(line.length, range.end - lineStart) }))
      .filter((range) => range.end > range.start);
    offset = lineEnd + 1;
    return (
      <span className="document-code-line" key={index}>
        <span className="document-code-line-number">{index + 1}</span>
        <span className="document-code-line-content">{lineRanges.length > 0 ? highlightTextRanges(line, lineRanges, searchState) : renderHighlightedCode(line, language, searchTerm, searchState)}</span>
      </span>
    );
  });
}

function renderHighlightedCode(content: string, language: string, searchTerm = '', searchState?: SearchRenderState) {
  const lower = language.toLowerCase();
  if (!['java', 'kt', 'kotlin', 'js', 'jsx', 'ts', 'tsx'].includes(lower)) {
    return highlightPlainText(content, searchTerm, searchState);
  }
  return highlightCodeLine(content, lower, searchTerm, searchState);
}

const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue',
  'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'if', 'implements',
  'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public',
  'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient',
  'try', 'void', 'volatile', 'while', 'record', 'var', 'true', 'false', 'null'
]);

function highlightCodeLine(line: string, language: string, searchTerm = '', searchState?: SearchRenderState) {
  const tokenPattern = /(\/\/.*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@[A-Za-z_]\w*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(line))) {
    if (match.index > lastIndex) {
      parts.push(...highlightPlainText(line.slice(lastIndex, match.index), searchTerm, searchState));
    }
    const token = match[0];
    parts.push(<span className={syntaxClass(token, language)} key={`${match.index}-${token}`}>{highlightPlainText(token, searchTerm, searchState)}</span>);
    lastIndex = match.index + token.length;
    if (token.startsWith('//')) {
      break;
    }
  }
  if (lastIndex < line.length) {
    parts.push(...highlightPlainText(line.slice(lastIndex), searchTerm, searchState));
  }
  return parts;
}

function syntaxClass(token: string, language: string) {
  if (token.startsWith('//')) return 'syntax-comment';
  if (token.startsWith('"') || token.startsWith("'")) return 'syntax-string';
  if (token.startsWith('@')) return 'syntax-annotation';
  if (/^\d/.test(token)) return 'syntax-number';
  if (language === 'java' && JAVA_KEYWORDS.has(token)) return 'syntax-keyword';
  return 'syntax-identifier';
}

function fullDocumentPath(rootPath: string | null, filePath: string) {
  if (!rootPath) return filePath;
  const cleanRoot = rootPath.endsWith("/") ? rootPath.slice(0, -1) : rootPath;
  const cleanPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
  return `${cleanRoot}/${cleanPath}`;
}

function resolveMarkdownAsset(rootPath: string | null, filePath: string, target: string) {
  if (/^[a-z]+:\/\//i.test(target) || target.startsWith('data:')) {
    return target;
  }
  if (!rootPath) {
    return target;
  }
  const cleanTarget = decodeURI(target.split(/[?#]/)[0] ?? target);
  const baseParts = filePath.split('/').slice(0, -1);
  const parts = cleanTarget.startsWith('/') ? cleanTarget.split('/') : [...baseParts, ...cleanTarget.split('/')];
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }
  return convertFileSrc(`${rootPath}/${normalized.join('/')}`);
}

function MermaidDiagram({ chart }: { chart: string }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sourceCollapsed, setSourceCollapsed] = useState(true);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [copyMessage, setCopyMessage] = useState('');
  const previewScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `document-mermaid-${Math.random().toString(36).slice(2)}`;
    void import('mermaid')
      .then(({ default: mermaid }) => {
        mermaid.initialize({ securityLevel: 'strict', startOnLoad: false, theme: 'default' });
        return mermaid.render(id, chart);
      })
      .then((result) => {
        if (!cancelled) {
          setSvg(result.svg);
          setError(null);
        }
      })
      .catch((renderError) => {
        if (!cancelled) {
          setError(renderError instanceof Error ? renderError.message : String(renderError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chart]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const viewport = previewScrollRef.current;
      if (!viewport) {
        return;
      }
      viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
      viewport.scrollTop = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [zoom, previewCollapsed]);

  async function copySource() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(chart);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = chart;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        if (!document.execCommand('copy')) {
          throw new Error('clipboard copy failed');
        }
        textarea.remove();
      }
      setCopyMessage('Mermaid 源码已复制');
    } catch {
      setCopyMessage('复制失败，请检查剪贴板权限');
    }
    window.setTimeout(() => setCopyMessage(''), 2200);
  }

  function changeZoom(delta: number) {
    setZoom((current) => Math.min(2.5, Math.max(1, Number((current + delta).toFixed(1)))));
  }

  const splitClassName = [
    'document-mermaid-split',
    sourceCollapsed ? 'source-collapsed' : '',
    previewCollapsed ? 'preview-collapsed' : '',
  ].filter(Boolean).join(' ');

  return (
    <figure className="document-mermaid-figure">
      <header className="document-mermaid-header">
        <div className="document-mermaid-title">
          <strong>Mermaid 图</strong>
          <span>源码与预览</span>
        </div>
        <div className="document-mermaid-actions">
          <button aria-label={sourceCollapsed ? '显示 Mermaid 源码' : '收起 Mermaid 源码'} className="document-mermaid-action" onClick={() => { setSourceCollapsed((current) => !current); if (!sourceCollapsed) setPreviewCollapsed(false); }} title={sourceCollapsed ? '显示源码' : '收起源码'} type="button">
            {sourceCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            {sourceCollapsed ? '显示源码' : '收起源码'}
          </button>
          <button aria-label={previewCollapsed ? '显示 Mermaid 预览' : '收起 Mermaid 预览'} className="document-mermaid-action" onClick={() => { setPreviewCollapsed((current) => !current); if (!previewCollapsed) setSourceCollapsed(false); }} title={previewCollapsed ? '显示预览' : '收起预览'} type="button">
            {previewCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            {previewCollapsed ? '显示预览' : '收起预览'}
          </button>
          <button aria-label="复制 Mermaid 源码" className="document-mermaid-action primary" onClick={() => void copySource()} title="复制 Mermaid 源码" type="button">
            <Copy size={14} />
            复制源码
          </button>
        </div>
      </header>

      <div className={splitClassName}>
        <section aria-label="Mermaid 源码" className="document-mermaid-source-pane">
          <div className="document-mermaid-pane-header"><strong>源码</strong><span>可选中复制</span></div>
          <pre><code>{chart}</code></pre>
        </section>
        <section aria-label="Mermaid 图预览" className="document-mermaid-preview-pane">
          <div className="document-mermaid-pane-header"><strong>预览</strong><span>SVG 矢量渲染</span></div>
          <div className="document-mermaid-preview-scroll" ref={previewScrollRef}>
            <div aria-label="Mermaid 图矢量画布" className="document-mermaid-stage" data-renderer="svg" style={{ width: `${Math.round(zoom * 100)}%`, minWidth: zoom > 1 ? `${Math.round(640 * zoom)}px` : undefined }}>
              {error ? (
                <pre className="document-mermaid-error"><code>{error}</code></pre>
              ) : svg ? (
                <div className="document-mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
              ) : (
                <div className="document-mermaid loading">正在渲染 Mermaid...</div>
              )}
            </div>
          </div>
          <footer className="document-mermaid-zoom-toolbar">
            <button aria-label="缩小 Mermaid 图" className="document-mermaid-zoom-button" disabled={zoom <= 1} onClick={() => changeZoom(-0.1)} title="缩小" type="button"><Minus size={14} /></button>
            <span aria-label="Mermaid 缩放比例">{Math.round(zoom * 100)}%</span>
            <button aria-label="放大 Mermaid 图" className="document-mermaid-zoom-button" disabled={zoom >= 2.5} onClick={() => changeZoom(0.1)} title="放大"><Plus size={14} /></button>
            <button aria-label="重置 Mermaid 图缩放" className="document-mermaid-reset" disabled={zoom === 1} onClick={() => setZoom(1)} title="重置缩放" type="button"><RotateCcw size={13} />重置</button>
            {copyMessage && <span aria-live="polite" className="document-mermaid-copy-message"><Check size={13} />{copyMessage}</span>}
          </footer>
        </section>
      </div>
    </figure>
  );
}

function MarkdownTable({ lines }: { lines: string[] }) {
  const headers = splitMarkdownTableRow(lines[0]);
  const rows = lines.slice(2).map(splitMarkdownTableRow).filter((row) => row.length > 0);
  return (
    <div className="document-markdown-table-wrap">
      <table className="document-markdown-table">
        <thead>
          <tr>{headers.map((header, index) => <th key={index}>{renderInlineMarkdown(header)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{renderInlineMarkdown(row[cellIndex] ?? '')}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isMarkdownTableStart(lines: string[], index: number) {
  if (index + 1 >= lines.length) {
    return false;
  }
  const header = splitMarkdownTableRow(lines[index]);
  const delimiter = splitMarkdownTableRow(lines[index + 1]);
  return header.length > 1 && delimiter.length === header.length && delimiter.every((cell) => /^:?-+:?$/.test(cell));
}

function splitMarkdownTableRow(line: string) {
  const trimmed = line.trim();
  const content = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const withoutTrailingPipe = content.endsWith('|') && !content.endsWith('\\|') ? content.slice(0, -1) : content;
  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  for (const char of withoutTrailingPipe) {
    if (escaped) {
      cell += char === '|' ? '|' : `\\${char}`;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  if (escaped) {
    cell += '\\';
  }
  cells.push(cell.trim());
  return cells;
}

function isMarkdownTableRow(line: string) {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|');
}

function renderInlineMarkdown(text: string, searchTerm = '', searchState?: SearchRenderState): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(...highlightPlainText(text.slice(lastIndex, match.index), searchTerm, searchState));
    }
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(<code className="document-inline-code" key={`${match.index}-code`}>{highlightPlainText(token.slice(1, -1), searchTerm, searchState)}</code>);
    } else {
      nodes.push(<strong key={`${match.index}-strong`}>{highlightPlainText(token.slice(2, -2), searchTerm, searchState)}</strong>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    nodes.push(...highlightPlainText(text.slice(lastIndex), searchTerm, searchState));
  }
  return nodes;
}


function DocumentContextMenu({ favorite, menu, onCopy, onCopyFull, onRunPrompt, onToggleFavorite }: {
  favorite: boolean;
  menu: { node: DocumentNode; x: number; y: number };
  onCopy: (text: string) => void;
  onCopyFull: (node: DocumentNode) => void;
  onRunPrompt: (kind: 'explain' | 'summary' | 'risk' | 'todo', node: DocumentNode) => void;
  onToggleFavorite: () => void;
}) {
  const node = menu.node;
  return (
    <div className="document-context-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
      {node.kind === 'file' && <button onClick={() => onRunPrompt('explain', node)} role="menuitem" type="button">发给当前会话解释</button>}
      {node.kind === 'file' && <button onClick={() => onRunPrompt('summary', node)} role="menuitem" type="button">生成摘要</button>}
      {node.kind === 'file' && <button onClick={() => onRunPrompt('risk', node)} role="menuitem" type="button">找风险点</button>}
      {node.kind === 'file' && <button onClick={() => onRunPrompt('todo', node)} role="menuitem" type="button">生成待办</button>}
      <button onClick={onToggleFavorite} role="menuitem" type="button">{favorite ? '取消收藏' : '收藏'}</button>
      <button onClick={() => onCopyFull(node)} role="menuitem" type="button">复制完整路径</button>
      <button onClick={() => onCopy(node.path)} role="menuitem" type="button">复制相对路径</button>
      <button onClick={() => onCopy(node.name)} role="menuitem" type="button">复制名称</button>
    </div>
  );
}

function DocumentSelectionContextMenu({ menu, onInsert, onInsertWithPath }: {
  menu: { text: string; x: number; y: number };
  onInsert: () => void;
  onInsertWithPath: () => void;
}) {
  return (
    <div aria-label="选中文本操作" className="document-context-menu document-selection-context-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
      <button onClick={onInsert} role="menuitem" type="button">插入引用</button>
      <button onClick={onInsertWithPath} role="menuitem" type="button">带路径插入引用</button>
    </div>
  );
}

function highlightText(text: string, keyword: string) {
  return highlightPlainText(text, keyword);
}

function highlightPlainText(text: string, searchTerm = '', searchState?: SearchRenderState): ReactNode[] {
  return highlightTextRanges(text, computeNormalizedSearchRanges(text, searchTerm), searchState);
}

function highlightTextRanges(text: string, ranges: TextRange[], searchState?: SearchRenderState): ReactNode[] {
  if (ranges.length === 0) return [text];
  const nodes: ReactNode[] = [];
  let index = 0;
  for (const range of mergeRanges(ranges)) {
    if (range.start > index) nodes.push(text.slice(index, range.start));
    const hitIndex = searchState?.nextHitIndex?.() ?? range.hitIndex ?? 0;
    const active = hitIndex === searchState?.activeSearchIndex;
    nodes.push(<mark className={active ? 'document-search-hit active' : 'document-search-hit'} data-search-hit-index={hitIndex} key={`${range.start}-${range.end}-${hitIndex}`}>{text.slice(range.start, range.end)}</mark>);
    index = range.end;
  }
  if (index < text.length) nodes.push(text.slice(index));
  return nodes;
}

type SearchRenderState = { activeSearchIndex: number; nextHitIndex?: () => number };

function createSearchRenderState(activeSearchIndex: number): SearchRenderState {
  let hitIndex = 0;
  return {
    activeSearchIndex,
    nextHitIndex: () => hitIndex++,
  };
}

type TextRange = { start: number; end: number; hitIndex?: number };

function computeNormalizedSearchRanges(text: string, searchTerm = ''): TextRange[] {
  const needle = normalizeSearchText(searchTerm);
  if (!needle) return [];
  const normalized = normalizeSearchTextWithMap(text);
  const ranges: TextRange[] = [];
  let hit = normalized.text.indexOf(needle);
  while (hit >= 0) {
    const lastNormalizedIndex = hit + needle.length - 1;
    const start = normalized.map[hit] ?? 0;
    const end = (normalized.map[lastNormalizedIndex] ?? start) + 1;
    ranges.push({ hitIndex: ranges.length, start, end });
    hit = normalized.text.indexOf(needle, hit + Math.max(1, needle.length));
  }
  return ranges;
}

function normalizeSearchText(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeSearchTextWithMap(value: string) {
  let text = '';
  const map: number[] = [];
  let pendingSpaceIndex: number | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (/\s/.test(char)) {
      if (text && !text.endsWith(' ')) {
        pendingSpaceIndex = index;
      }
      continue;
    }
    if (pendingSpaceIndex !== null) {
      text += ' ';
      map.push(pendingSpaceIndex);
      pendingSpaceIndex = null;
    }
    text += char.toLowerCase();
    map.push(index);
  }
  return { text, map };
}

function mergeRanges(ranges: TextRange[]) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function extractMarkdownOutline(content: string) {
  return content.split(/\r?\n/).flatMap((line, index) => {
    const match = line.trim().match(/^(#{1,3})\s+(.+)$/);
    return match ? [{ id: headingIdFor(match[2], index), level: match[1].length, title: match[2] }] : [];
  });
}

function headingIdFor(text: string, index: number) {
  const slug = text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '') || 'heading';
  return `${slug}-${index}`;
}

function treeFilterLabel(filter: TreeFilter) {
  if (filter === 'open') return '已打开';
  if (filter === 'favorite') return '收藏';
  return '全部';
}

function buildTreeContext(nodes: DocumentNode[], depth = 0): string {
  return nodes.slice(0, 80).map((node) => {
    const current = `${'  '.repeat(depth)}- ${node.kind === 'directory' ? '目录' : '文件'} ${node.path}`;
    if (node.kind !== 'directory') {
      return current;
    }
    const children = buildTreeContext(node.children ?? [], depth + 1);
    return children ? `${current}\n${children}` : current;
  }).join('\n');
}

function ancestorDirectoryPaths(path: string) {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

function toggleStringInSet(current: Set<string>, value: string) {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function rootFavoriteKey(rootPath: string) {
  return `${ROOT_FAVORITE_PREFIX}${rootPath}`;
}

function loadStringSet(key: string) {
  return new Set(loadStringList(key));
}

function loadStringList(key: string) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function collectTopLevelDirectoryPaths(nodes: DocumentNode[]) {
  return nodes.filter((node) => node.kind === 'directory').map((node) => node.path);
}

function collectDirectoryPaths(nodes: DocumentNode[]) {
  return nodes.flatMap((node): string[] => {
    if (node.kind !== 'directory') {
      return [];
    }
    return [node.path, ...collectDirectoryPaths(node.children ?? [])];
  });
}

function preserveExistingOpenPaths(current: Set<string>, nodes: DocumentNode[]) {
  const available = new Set(collectDirectoryPaths(nodes));
  return new Set([...current].filter((path) => available.has(path)));
}

async function restoreOpenedFiles(rootPath: string, nodes: DocumentNode[], openedPaths: string[] | undefined) {
  const uniquePaths = [...new Set(openedPaths ?? [])].slice(0, 8);
  if (uniquePaths.length === 0) {
    return [];
  }
  const files = await Promise.all(uniquePaths.map(async (path) => {
    const node = findNode(nodes, path);
    if (node?.kind !== 'file') {
      return null;
    }
    try {
      return await readDocumentFile(rootPath, node.path);
    } catch {
      return null;
    }
  }));
  return files.filter((file): file is DocumentFileContent => Boolean(file));
}

function findNode(nodes: DocumentNode[], path: string): DocumentNode | null {
  for (const node of nodes) {
    if (node.path === path) {
      return node;
    }
    if (node.kind === 'directory') {
      const found = findNode(node.children ?? [], path);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function insertSelectedText(onInsertText: (text: string) => void) {
  const text = getSelectedText();
  if (text) {
    onInsertText(text);
  }
}

function getSelectedText() {
  return window.getSelection()?.toString().trim() ?? '';
}

function loadDocumentPanelState(): PersistedDocumentPanelState | null {
  try {
    const raw = localStorage.getItem(DOCUMENT_PANEL_STATE_KEY);
    if (!raw) {
      return null;
    }
    const value = JSON.parse(raw) as Partial<PersistedDocumentPanelState>;
    if (typeof value.rootPath !== 'string') {
      return null;
    }
    return {
      documentTreeCollapsed: typeof value.documentTreeCollapsed === 'boolean' ? value.documentTreeCollapsed : undefined,
      documentTreeWidth: typeof value.documentTreeWidth === 'number' && Number.isFinite(value.documentTreeWidth)
        ? clampDocumentTreeWidth(value.documentTreeWidth)
        : undefined,
      openedPaths: Array.isArray(value.openedPaths) ? value.openedPaths.filter((item): item is string => typeof item === 'string') : undefined,
      openPaths: Array.isArray(value.openPaths) ? value.openPaths.filter((item): item is string => typeof item === 'string') : undefined,
      outlineOpen: typeof value.outlineOpen === 'boolean' ? value.outlineOpen : undefined,
      rootPath: value.rootPath,
      selectedPath: typeof value.selectedPath === 'string' ? value.selectedPath : null,
      treeFilter: isTreeFilter(value.treeFilter) ? value.treeFilter : undefined,
    };
  } catch {
    return null;
  }
}

function saveDocumentPanelState(state: Partial<PersistedDocumentPanelState> & { rootPath: string }) {
  const previous = loadDocumentPanelState();
  localStorage.setItem(DOCUMENT_PANEL_STATE_KEY, JSON.stringify({ ...previous, ...state }));
}

function clampDocumentTreeWidth(value: number, maxWidth = Number.POSITIVE_INFINITY) {
  return Math.round(Math.min(maxWidth, Math.max(DOCUMENT_TREE_MIN_WIDTH, value)));
}

function isTreeFilter(value: unknown): value is TreeFilter {
  return value === 'all' || value === 'open' || value === 'favorite';
}


function filterNodesByMode(nodes: DocumentNode[], mode: TreeFilter, options: { favoritePaths: Set<string>; keyword: string; openedPaths: Set<string>; rootFavoriteId: string | null }): DocumentNode[] {
  if (mode === 'favorite' && options.rootFavoriteId && options.favoritePaths.has(options.rootFavoriteId)) {
    return filterNodes(nodes, options.keyword);
  }
  return nodes.flatMap((node) => {
    const keywordMatch = !options.keyword || node.name.toLowerCase().includes(options.keyword) || node.path.toLowerCase().includes(options.keyword);
    if (mode === 'favorite' && options.favoritePaths.has(node.path)) {
      if (!options.keyword) {
        return [node];
      }
      const filteredSelf = filterNodes([node], options.keyword);
      return filteredSelf.length > 0 ? filteredSelf : [node];
    }
    const modeMatch = mode === 'all' || (mode === 'open' && node.kind === 'file' && options.openedPaths.has(node.path));
    if (node.kind === 'file') {
      return keywordMatch && modeMatch ? [node] : [];
    }
    const children = filterNodesByMode(node.children ?? [], mode, options);
    return (keywordMatch && modeMatch) || children.length > 0 ? [{ ...node, children }] : [];
  });
}

function filterNodes(nodes: DocumentNode[], keyword: string): DocumentNode[] {
  if (!keyword) {
    return nodes;
  }
  return nodes.flatMap((node) => {
    const selfMatch = node.name.toLowerCase().includes(keyword) || node.path.toLowerCase().includes(keyword);
    if (node.kind === 'file') {
      return selfMatch ? [node] : [];
    }
    const children = filterNodes(node.children ?? [], keyword);
    return selfMatch || children.length > 0 ? [{ ...node, children }] : [];
  });
}

function fileTypeLabel(extension: string) {
  const lower = extension.toLowerCase();
  if (lower === 'md' || lower === 'markdown') return 'Markdown';
  if (lower === 'java') return 'Java';
  if (lower === 'json') return 'JSON';
  return lower ? lower.toUpperCase() : '文本';
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
