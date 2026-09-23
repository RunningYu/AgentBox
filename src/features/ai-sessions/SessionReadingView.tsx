import { ChevronDown, ChevronRight, Clipboard, Copy, List, TerminalSquare } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AgentType, ClaudeTranscriptMessage } from '../../shared/types';
import { loadClaudeTranscript, loadCodexTranscript } from './terminalApi';

interface SessionReadingViewProps {
  history: string;
  agent?: AgentType;
  cwd?: string;
  cliSessionId?: string;
}

interface ReadingBlock {
  id: number;
  kind: 'assistant' | 'user' | 'process' | 'error';
  text: string;
}

type OutlineFilter = 'all' | 'user' | 'assistant';

export function parseSessionReadingBlocks(history: string): ReadingBlock[] {
  return buildReadingBlocks(history);
}

const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function SessionReadingView({ history, agent, cwd, cliSessionId }: SessionReadingViewProps) {
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [outlineFilter, setOutlineFilter] = useState<OutlineFilter>('all');
  const [structuredTranscript, setStructuredTranscript] = useState<ClaudeTranscriptMessage[] | null>(null);
  const [structuredLoading, setStructuredLoading] = useState(false);
  const [codexTranscript, setCodexTranscript] = useState<ClaudeTranscriptMessage[] | null>(null);
  const [codexTranscriptLoading, setCodexTranscriptLoading] = useState(false);
  const blockRefs = useRef<Record<number, HTMLElement | null>>({});
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (agent !== 'claude' || !cwd || !cliSessionId) {
      setStructuredTranscript(null);
      setStructuredLoading(false);
      return;
    }
    let cancelled = false;
    setStructuredLoading(structuredTranscript === null);
    const timer = window.setTimeout(() => {
      void loadClaudeTranscript(cwd, cliSessionId)
        .then((messages) => {
          if (!cancelled) setStructuredTranscript(messages.length > 0 ? messages : null);
        })
        .catch(() => {
          if (!cancelled) setStructuredTranscript(null);
        })
        .finally(() => {
          if (!cancelled) setStructuredLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [agent, cliSessionId, cwd, history]);
  useEffect(() => {
    if (agent !== 'codex' || !cwd || !cliSessionId) {
      setCodexTranscript(null);
      setCodexTranscriptLoading(false);
      return;
    }
    let cancelled = false;
    setCodexTranscriptLoading(codexTranscript === null);
    const timer = window.setTimeout(() => {
      void loadCodexTranscript(cwd, cliSessionId)
        .then((messages) => {
          if (!cancelled) setCodexTranscript(messages.length > 0 ? messages : null);
        })
        .catch(() => {
          if (!cancelled) setCodexTranscript(null);
        })
        .finally(() => {
          if (!cancelled) setCodexTranscriptLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [agent, cliSessionId, cwd, history]);
  const blocks = useMemo(() => structuredLoading
    ? []
    : agent === 'claude' && structuredTranscript
    ? structuredTranscript.map((message, id) => ({ id, kind: message.kind, text: message.text }))
    : agent === 'codex' && codexTranscriptLoading
    ? []
    : agent === 'codex' && codexTranscript
    ? codexTranscript.map((message, id) => ({ id, kind: message.kind, text: message.text }))
    : buildReadingBlocks(history), [agent, codexTranscript, codexTranscriptLoading, history, structuredLoading, structuredTranscript]);
  const outlineBlocks = useMemo(() => outlineFilter === 'all'
    ? blocks
    : blocks.filter((block) => block.kind === outlineFilter), [blocks, outlineFilter]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const frame = window.requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [blocks]);

  async function copy(text: string) {
    await invoke('set_clipboard_text', { text });
  }

  if (!blocks.length) {
    return <div className="session-reading-empty"><TerminalSquare size={22} /><span>暂无可阅读的会话记录</span><small>CLI 输出会在会话运行后自动整理到这里</small></div>;
  }

  return (
    <div aria-label="会话阅读视图" className={outlineOpen ? 'session-reading-view' : 'session-reading-view outline-collapsed'}>
      <div className="session-reading-toolbar"><span>只读阅读视图 · 本地转录</span><button aria-label="复制全部会话记录" className="session-reading-copy" onClick={() => void copy(blocks.map((block) => block.text).join('\n\n'))} title="复制全部" type="button"><Copy size={14} />复制全部</button></div>
      <div className="session-reading-main">
        <div className="session-reading-list" ref={listRef}>
          {blocks.map((block) => {
          const isCollapsed = collapsed[block.id] === true;
          return (
            <article className={`session-reading-block reading-${block.kind}`} key={block.id} ref={(node) => { blockRefs.current[block.id] = node; }}>
              <header>
                <button aria-expanded={!isCollapsed} onClick={() => setCollapsed((current) => ({ ...current, [block.id]: !current[block.id] }))} type="button">{isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}<strong>{block.kind === 'user' ? '你' : block.kind === 'error' ? '错误 / 警告' : 'AI 回复'}</strong></button>
                <button aria-label={`复制第 ${block.id + 1} 段记录`} className="session-reading-copy" onClick={() => void copy(block.text)} title="复制" type="button"><Clipboard size={13} /></button>
              </header>
              {!isCollapsed && <div className="session-reading-content">{block.kind === 'assistant' ? renderReadingMarkdown(block.text) : <pre>{block.text}</pre>}</div>}
            </article>
          );
          })}
        </div>
        {outlineOpen && <aside aria-label="对话目录" className="session-reading-outline">
          <header><span><List size={15} />对话目录</span><button aria-label="收起对话目录" onClick={() => setOutlineOpen(false)} type="button"><ChevronRight size={15} /></button></header>
          <div aria-label="对话目录筛选" className="reading-outline-filters">
            {([['all', '全部'], ['user', '你'], ['assistant', 'AI']] as const).map(([value, label]) => <button aria-pressed={outlineFilter === value} className={outlineFilter === value ? 'active' : ''} key={value} onClick={() => setOutlineFilter(value)} type="button">{label}</button>)}
          </div>
          <nav>
            {outlineBlocks.map((block) => <button className={`reading-outline-item reading-outline-${block.kind}`} key={block.id} onClick={() => blockRefs.current[block.id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })} type="button"><b>{block.id + 1}</b><span>{outlineLabel(block)}</span></button>)}
          </nav>
        </aside>}
        {!outlineOpen && <button aria-label="展开对话目录" className="session-reading-outline-collapsed" onClick={() => setOutlineOpen(true)} title="展开对话目录" type="button"><List size={15} /></button>}
      </div>
    </div>
  );
}

function buildReadingBlocks(history: string): ReadingBlock[] {
  const cleaned = normalizeTerminalHistory(history);
  const lines = cleaned.split('\n').map((line) => line.trimEnd());
  const blocks: ReadingBlock[] = [];
  let current: string[] = [];
  let currentKind: ReadingBlock['kind'] = 'assistant';
  let userEnded = false;
  let suppressToolOutput = false;
  const flush = () => {
    const text = current.join('\n').trim();
    if (text) blocks.push({ id: blocks.length, kind: currentKind, text });
    current = [];
    currentKind = 'assistant';
    userEnded = false;
    suppressToolOutput = false;
  };
  for (const line of lines) {
    const value = line.trim();
    if (!value) {
      if (currentKind === 'user') flush();
      continue;
    }
    if (isNoiseLine(line)) {
      if (currentKind === 'user') flush();
      continue;
    }

    // Only prompt glyphs emitted by the agent TUIs start a user turn.
    // A bare `$` or `>` is too ambiguous because status lines contain both.
    const prompt = line.match(/^\s*(?:›|❯|(?:you|用户)\s*[:：])\s?(.*)$/i);
    if (prompt) {
      if (!prompt[1].trim() || isNoiseLine(prompt[1]) || isToolStatus(prompt[1]) || isPromptPlaceholder(prompt[1])) continue;
      if (current.length) flush();
      currentKind = 'user';
      current.push(prompt[1]);
      continue;
    }

    // Claude uses a bullet for assistant turns. Tool bullets are status only.
    const assistantMarker = value.match(/^(?:⏺|●|•|(?:assistant|ai)\s*[:：])\s?(.*)$/i);
    if (assistantMarker) {
      if (isToolStatus(assistantMarker[1])) {
        suppressToolOutput = true;
        continue;
      }
      if (current.length) flush();
      currentKind = 'assistant';
      suppressToolOutput = false;
      current.push(assistantMarker[1]);
      continue;
    }

    if (isToolStatus(value)) {
      if (currentKind === 'user') flush();
      suppressToolOutput = true;
      continue;
    }

    if (suppressToolOutput) {
      // Tool output is usually followed by a natural-language explanation.
      // Codex does not always emit a dedicated assistant marker, so reopen
      // the conversation when prose resumes instead of hiding the rest.
      if (!looksLikeToolOutput(value) && looksLikeAssistantProse(value)) suppressToolOutput = false;
      else continue;
    }

    // Without an assistant marker, a blank line is the reliable turn boundary.
    if (currentKind === 'user' && userEnded) flush();
    if (isExplicitError(value)) {
      if (current.length) flush();
      currentKind = 'error';
    }
    current.push(line);
  }
  flush();
  if (blocks.length) return dedupeRedrawUserTurns(blocks, history);
  const fallback = normalizeTerminalHistory(history)
    .split('\n')
    .filter((line) => line.trim() && !isNoiseLine(line) && !isToolStatus(line.trim()))
    .join('\n')
    .trim();
  return fallback ? [{ id: 0, kind: 'assistant', text: fallback }] : [];
}

function isNoiseLine(line: string) {
  const value = line.trim();
  return !value || /^[-_=─━]{6,}$/.test(value) || /^\[[\d;?]+[a-zA-Z]$/.test(value)
    || /(?:zz-(?:claude|codex)|\bgit:\()/.test(value)
    || /^(?:[←→]\s*)?for\s+agents\b/i.test(value)
    || /^(?:Context|Tip)\b|^\**(?:Worked|Churned|Brewed|Crunched|Sautéed|Sauteed|Manifesting|Whirring|Brewing)\s*for\b|^[*✻✽✶✳✢·]\s*(?:Worked|Churned|Brewed|Crunched|Sautéed|Sauteed|Manifesting|Whirring|Brewing)\b|^high\s*(?:·\s*)?\/\s*effort/i.test(value)
    || /^(?:\d+\s+)?setup issues?:|^SessionStart:startup hook error|^Failed with non-blocking status code:/i.test(value)
    || /^\s*[╭╰│┌└┐┘├┤┬┴┼─]+\s*$/.test(value)
    || /^\s*⎿/.test(value)
    || /^(?:esc|ctrl|tab|shift)\b.*(?:interrupt|cancel|send|submit|permission|mode)/i.test(value);
}

function isToolStatus(value: string) {
  return /^(?:✓|✗|⟳|⏵|◐|◑|✶|✳|✢|·|✻|✽|↓)\s*(?:Explore|Search|Read|Edit|Write|Run|Bash|Update|WebFetch|WebSearch|Todo|Task|Fluttering|Grooving)\b/i.test(value)
    || /^(?:Explore|Search|Read|Edit|Write|Run|Bash|Update|WebFetch|WebSearch|Todo|Task)\s*(?:\(|:)/i.test(value)
    || /^(?:Fluttering|Grooving)\.{2,}|^(?:Fluttering|Grooving)…/i.test(value)
    || /^Worked for\b/i.test(value);
}

function looksLikeToolOutput(value: string) {
  return /^(?:[+\-]\s|@@|\d{2,5}[+\- ]|\|\s|PostToolUse|PreToolUse|node:|at\s+|diff\s|index\s|---\s|\+\+\+\s)/i.test(value)
    || /^(?:Added|Removed|modified|created|deleted)\s+\d+\s+(?:lines?|files?)/i.test(value)
    || /(?:hook error|non-blocking status code|Failed with)/i.test(value)
    || /^(?:[\w./-]+\/)+[\w.$-]+\)?$/.test(value)
    || /^(?:\d{2,5}\s+)?[+\- ]?(?:public|private|protected|static|final|class|if|else|return|import|package|\{|\})\b/.test(value);
}

function looksLikeAssistantProse(value: string) {
  return /[。！？：；，]/.test(value) && !/^(?:Update|Bash|Read|Edit|Write|Run|Explore|Search)\b/i.test(value);
}

function isPromptPlaceholder(value: string) {
  return /^(?:Ask Codex to do anything|Type something|foragents|high\s*\/\s*effort|Context\b)/i.test(value.trim());
}

function normalizeTerminalHistory(history: string) {
  const stripped = history.replace(ANSI_PATTERN, '').replace(/\r\n/g, '\n').replace(CONTROL_PATTERN, '');
  // Do not convert cursor redraws into line breaks or select only the text
  // after the last CR. PTY logs contain CRs both for real line endings and
  // for repaint frames; dropping them preserves readable content in either case.
  const normalized = stripped.replace(/\r/g, '')
    .replace(/([^\n])(?=\s*(?:›|❯|⏺|●|•))/g, '$1\n')
    .replace(/([^\n])(?=\s*[*✻✽✶✳✢·]\s*(?:Churned|Brewed|Crunched|Sautéed|Sauteed|Manifesting|Whirring|Brewing|Worked)\b)/gi, '$1\n')
    .replace(/([^\n])(?=(?:Update|Bash|Read|Edit|Write|Run|Explore|Search)\s*\()/g, '$1\n');
  // TUI redraws generate long runs of empty lines and often repeat the same
  // status line in adjacent frames. Keep intentional paragraph boundaries,
  // but prevent redraw artifacts from becoming fake turns in the transcript.
  const compactLines = normalized.split('\n').map((line) => line.trimEnd());
  const deduped: string[] = [];
  for (const line of compactLines) {
    if (line && line === deduped[deduped.length - 1]) continue;
    if (!line && deduped[deduped.length - 1] === '') continue;
    deduped.push(line);
  }
  return deduped.join('\n').replace(/\n{3,}/g, '\n\n');
}

function dedupeRedrawUserTurns(blocks: ReadingBlock[], history: string): ReadingBlock[] {
  // Claude's alternate-screen redraw can emit the same prompt once per frame.
  // Only dedupe when the source visibly contains TUI chrome; ordinary repeated
  // questions in a clean transcript must remain separate turns.
  const looksLikeRedraw = /(?:Context\b|for\s+agents\b|setup issues?|(?:Churned|Brewed|Crunched|Sautéed|Sauteed)\s+for)/i.test(history);
  if (!looksLikeRedraw) return blocks;
  const seenUsers = new Set<string>();
  return blocks.filter((block) => {
    if (block.kind !== 'user') return true;
    const key = block.text.replace(/\s+/g, ' ').trim();
    if (seenUsers.has(key)) return false;
    seenUsers.add(key);
    return true;
  }).map((block, index) => ({ ...block, id: index }));
}

function isExplicitError(value: string) {
  return /^(?:error|fatal|failed|exception|warning|错误|失败|异常|警告)\s*[:：]/i.test(value)
    || /^(?:✗|×)\s+/.test(value);
}

function outlineLabel(block: ReadingBlock) {
  const text = block.text.replace(/\s+/g, ' ').trim();
  const prefix = block.kind === 'user' ? '你：' : block.kind === 'error' ? '错误：' : block.kind === 'process' ? '执行：' : 'AI：';
  return `${prefix}${text.slice(0, 38)}${text.length > 38 ? '…' : ''}`;
}

function renderReadingMarkdown(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const rendered: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```(.*)$/);
    if (fence) {
      const language = fence[1].trim().toLowerCase();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const isDiff = language === 'diff' || language === 'patch';
      rendered.push(
        <pre className={`reading-code reading-fenced-code${isDiff ? ' reading-diff' : ''}`} key={`fence-${index}`}>
          {language && <span className="reading-code-language">{language}</span>}
          <code>{isDiff ? renderReadingDiffLines(code) : code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (isMarkdownTableRow(lines[index])) {
      const tableLines: string[] = [];
      while (index < lines.length && isMarkdownTableRow(lines[index])) {
        tableLines.push(lines[index].trim());
        index += 1;
      }
      const rows = tableLines.map((line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()));
      const hasHeader = rows.length > 1 && rows[1].every((cell) => /^:?-{3,}:?$/.test(cell));
      const header = hasHeader ? rows[0] : undefined;
      const body = hasHeader ? rows.slice(2) : rows;
      rendered.push(
        <div className="reading-table-wrap" key={`table-${index}`}>
          <table>
            {header && <thead><tr>{header.map((cell, cellIndex) => <th key={cellIndex}>{renderInline(cell)}</th>)}</tr></thead>}
            <tbody>{body.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{renderInline(cell)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      const Heading = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4';
      rendered.push(<Heading key={`heading-${index}`}>{renderInline(heading[2])}</Heading>);
      index += 1;
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].trim().match(/^[-*+]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      rendered.push(<ul key={`ul-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ul>);
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].trim().match(/^\d+[.)]\s+(.+)$/);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      rendered.push(<ol key={`ol-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ol>);
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quote.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      rendered.push(<blockquote key={`quote-${index}`}>{quote.map((item, itemIndex) => <p key={itemIndex}>{renderInline(item)}</p>)}</blockquote>);
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      rendered.push(<hr key={`hr-${index}`} />);
      index += 1;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index].trim();
      if (!current || /^```/.test(current) || /^(#{1,6})\s+/.test(current)
        || /^[-*+]\s+/.test(current) || /^\d+[.)]\s+/.test(current)
        || current.startsWith('>') || /^---+$/.test(current) || isMarkdownTableRow(lines[index])) {
        break;
      }
      paragraph.push(lines[index]);
      index += 1;
    }

    if (paragraph.length >= 2 && paragraph.filter(isCodeLine).length >= Math.ceil(paragraph.length * 0.5)) {
      rendered.push(
        <pre className="reading-code reading-source" key={`source-${index}`}>
          {paragraph.map((line, lineIndex) => <span key={lineIndex}><code>{highlightCode(line)}</code>{lineIndex < paragraph.length - 1 && '\n'}</span>)}
        </pre>,
      );
      continue;
    }

    rendered.push(<p key={`p-${index}`}>{paragraph.map((line, lineIndex) => <span key={lineIndex}>{renderInline(line)}{lineIndex < paragraph.length - 1 && <br />}</span>)}</p>);
  }
  return rendered;
}

function isMarkdownTableRow(line: string) {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|');
}

function renderReadingDiffLines(lines: string[]): ReactNode[] {
  return lines.map((line, index) => {
    const tone = line.startsWith('+') && !line.startsWith('+++') ? 'reading-diff-added' : line.startsWith('-') && !line.startsWith('---') ? 'reading-diff-removed' : '';
    return <span className={tone} key={index}>{line}{index < lines.length - 1 && '\n'}</span>;
  });
}

function isCodeLine(line: string) {
  const value = line.trim();
  return /^(?:\d+\s+)?(?:public|private|protected|static|final|class|interface|enum|if|else|for|while|return|import|package|const|let|var|function|\{|\}|\);)/.test(value)
    || /[{}();]=|\.get[A-Z]\w*\(|\b(?:String|List|Map|BigDecimal|boolean|int|long)\b/.test(value);
}

function highlightCode(line: string): ReactNode {
  const parts = line.split(/(\/\/.*|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b(?:public|private|protected|static|final|class|interface|enum|if|else|for|while|return|new|import|package|void|boolean|int|long|true|false|null)\b)/g);
  return parts.map((part, index) => {
    if (/^\/\//.test(part) || /^\/\*/.test(part)) return <span className="code-comment" key={index}>{part}</span>;
    if (/^["']/.test(part)) return <span className="code-string" key={index}>{part}</span>;
    if (/^\d/.test(part)) return <span className="code-number" key={index}>{part}</span>;
    if (/^(?:public|private|protected|static|final|class|interface|enum|if|else|for|while|return|new|import|package|void|boolean|int|long|true|false|null)$/.test(part)) return <span className="code-keyword" key={index}>{part}</span>;
    return <span key={index}>{part}</span>;
  });
}

function renderInline(text: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code className="reading-inline-code" key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      return <a href={link[2]} key={index} rel="noreferrer" target="_blank">{link[1]}</a>;
    }
    return <span key={index}>{part}</span>;
  });
}
