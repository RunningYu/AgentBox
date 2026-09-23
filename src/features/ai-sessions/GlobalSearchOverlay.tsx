import { FileText, MessageSquare, Search, Wrench, X } from 'lucide-react';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { AiSessionGroup, AiSessionRecord, NormalizedFeatureDef } from '../../shared/types';
import type { DocumentSearchSnapshot } from './DocumentPanel';

export type GlobalSearchResult =
  | { id: string; kind: 'session'; title: string; description: string; sessionId: string }
  | { id: string; kind: 'tool'; title: string; description: string; featureId: string }
  | { id: string; kind: 'document'; title: string; description: string; path: string };

interface GlobalSearchOverlayProps {
  documentSnapshot: DocumentSearchSnapshot | null;
  features: NormalizedFeatureDef[];
  groups: AiSessionGroup[];
  loadSessionHistory: (sessionId: string) => Promise<string>;
  onClose: () => void;
  onOpenResult: (result: GlobalSearchResult) => void;
  open: boolean;
  sessions: AiSessionRecord[];
}

export function GlobalSearchOverlay({
  documentSnapshot,
  features,
  groups,
  loadSessionHistory,
  onClose,
  onOpenResult,
  open,
  sessions,
}: GlobalSearchOverlayProps) {
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const [historyTextBySessionId, setHistoryTextBySessionId] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) {
      setQuery('');
      setHighlighted(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !query.trim()) {
      return;
    }
    let cancelled = false;
    const missing = sessions.filter((session) => historyTextBySessionId[session.id] === undefined);
    if (missing.length === 0) {
      return;
    }
    void Promise.allSettled(missing.map(async (session) => [session.id, await loadSessionHistory(session.id)] as const))
      .then((results) => {
        if (cancelled) {
          return;
        }
        setHistoryTextBySessionId((current) => {
          const next = { ...current };
          for (const result of results) {
            if (result.status === 'fulfilled') {
              next[result.value[0]] = result.value[1];
            }
          }
          return next;
        });
      });
    return () => {
      cancelled = true;
    };
  }, [historyTextBySessionId, loadSessionHistory, open, query, sessions]);

  const results = useMemo(
    () => buildResults({
      documentSnapshot,
      features,
      groups,
      historyTextBySessionId,
      query,
      sessions,
    }),
    [documentSnapshot, features, groups, historyTextBySessionId, query, sessions],
  );

  useEffect(() => {
    setHighlighted((current) => Math.min(current, Math.max(results.length - 1, 0)));
  }, [results.length]);

  if (!open) {
    return null;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((current) => Math.min(current + 1, Math.max(results.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const result = results[highlighted];
      if (result) {
        onOpenResult(result);
      }
    }
  }

  return (
    <div className="global-search-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="global-search-dialog" role="dialog" aria-modal="true" aria-label="全局搜索">
        <header className="global-search-header">
          <Search size={18} />
          <input
            autoFocus
            aria-label="全局搜索"
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlighted(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="搜索会话、历史输出、工具箱、文件名和文档内容"
            value={query}
          />
          <button aria-label="关闭全局搜索" className="icon-button" onClick={onClose} title="关闭" type="button">
            <X size={16} />
          </button>
        </header>
        <div className="global-search-results">
          {results.length === 0 ? (
            <p className="empty">没有匹配结果</p>
          ) : (
            (['session', 'tool', 'document'] as const).map((kind) => {
              const groupResults = results.filter((result) => result.kind === kind);
              if (groupResults.length === 0) {
                return null;
              }
              return (
                <section className="global-search-group" key={kind}>
                  <strong>{kindLabel(kind)}</strong>
                  {groupResults.map((result) => {
                    const index = results.indexOf(result);
                    return (
                      <button
                        className={index === highlighted ? 'global-search-result active' : 'global-search-result'}
                        key={result.id}
                        onClick={() => onOpenResult(result)}
                        onMouseEnter={() => setHighlighted(index)}
                        type="button"
                      >
                        <span className="global-search-icon">{kindIcon(result.kind)}</span>
                        <span>
                          <span className="global-search-title">{highlightQuery(result.title, query)}</span>
                          <span className="global-search-description">{highlightQuery(result.description, query)}</span>
                        </span>
                        <kbd>↵</kbd>
                      </button>
                    );
                  })}
                </section>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

function buildResults({
  documentSnapshot,
  features,
  groups,
  historyTextBySessionId,
  query,
  sessions,
}: {
  documentSnapshot: DocumentSearchSnapshot | null;
  features: NormalizedFeatureDef[];
  groups: AiSessionGroup[];
  historyTextBySessionId: Record<string, string>;
  query: string;
  sessions: AiSessionRecord[];
}) {
  const normalized = normalizeQuery(query);
  const results: GlobalSearchResult[] = [];
  const groupById = new Map(groups.map((group) => [group.id, group.name]));

  for (const session of sessions) {
    const groupName = session.groupId ? groupById.get(session.groupId) ?? '未知分组' : '未分组';
    const history = historyTextBySessionId[session.id] ?? session.history ?? '';
    const matched = matches(`${session.name} ${groupName} ${session.cwd} ${session.agent}`, normalized) || matches(history, normalized);
    if (!matched) {
      continue;
    }
    results.push({
      id: `session-${session.id}`,
      kind: 'session',
      title: session.name,
      description: `${groupName} · ${session.agent} · ${snippet(history, normalized) || session.cwd}`,
      sessionId: session.id,
    });
  }

  for (const feature of features) {
    const text = `${feature.name} ${feature.description} ${feature.script ?? ''} ${feature.type}`;
    if (!matches(text, normalized)) {
      continue;
    }
    results.push({
      id: `tool-${feature.id}`,
      kind: 'tool',
      title: feature.name,
      description: `${feature.builtin ? '内置' : '自增'} · ${feature.type} · ${feature.description || snippet(feature.script ?? '', normalized) || '暂无简介'}`,
      featureId: feature.id,
    });
  }

  for (const file of flattenDocumentFiles(documentSnapshot)) {
    const text = `${file.name} ${file.path} ${file.content ?? ''}`;
    if (!matches(text, normalized)) {
      continue;
    }
    results.push({
      id: `document-${file.path}`,
      kind: 'document',
      title: file.name,
      description: `${file.path}${file.content ? ` · ${snippet(file.content, normalized)}` : ''}`,
      path: file.path,
    });
  }

  return results.slice(0, 80);
}

function flattenDocumentFiles(snapshot: DocumentSearchSnapshot | null) {
  const fromTree = flattenNodes(snapshot?.nodes ?? []);
  const opened = snapshot?.openedFiles.map((file) => ({
    content: file.content,
    name: file.name,
    path: file.path,
  })) ?? [];
  const selected = snapshot?.selected ? [{
    content: snapshot.selected.content,
    name: snapshot.selected.name,
    path: snapshot.selected.path,
  }] : [];
  const byPath = new Map([...fromTree, ...opened, ...selected].map((file) => [file.path, file]));
  return [...byPath.values()];
}

function flattenNodes(nodes: DocumentSearchSnapshot['nodes']): Array<{ content?: string; name: string; path: string }> {
  return nodes.flatMap((node): Array<{ content?: string; name: string; path: string }> => (
    node.kind === 'file'
      ? [{ name: node.name, path: node.path }]
      : flattenNodes(node.children ?? [])
  ));
}

function matches(value: string, query: string) {
  if (!query) {
    return true;
  }
  return normalizeQuery(value).includes(query);
}

function normalizeQuery(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function snippet(value: string, query: string) {
  if (!value.trim()) {
    return '';
  }
  const normalizedValue = normalizeQuery(value);
  const index = query ? normalizedValue.indexOf(query) : -1;
  if (index < 0) {
    return value.trim().slice(0, 80);
  }
  return value.trim().slice(Math.max(0, index - 26), index + query.length + 54);
}

function kindLabel(kind: GlobalSearchResult['kind']) {
  if (kind === 'session') return '会话';
  if (kind === 'tool') return '工具';
  return '文档';
}

function kindIcon(kind: GlobalSearchResult['kind']) {
  if (kind === 'session') return <MessageSquare size={15} />;
  if (kind === 'tool') return <Wrench size={15} />;
  return <FileText size={15} />;
}

function highlightQuery(text: string, query: string) {
  const normalized = query.trim();
  if (!normalized) {
    return text;
  }
  const index = text.toLowerCase().indexOf(normalized.toLowerCase());
  if (index < 0) {
    return text;
  }
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + normalized.length)}</mark>
      {text.slice(index + normalized.length)}
    </>
  );
}
