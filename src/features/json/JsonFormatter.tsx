import { ChevronDown, ChevronRight, Copy, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

interface JsonFormatterProps {
  onClose: () => void;
  onCopy: (text: string) => Promise<void>;
}

export function JsonFormatter({ onClose, onCopy }: JsonFormatterProps) {
  const [input, setInput] = useState('');
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const resizeStart = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const formatted = useMemo(() => formatJson(input), [input]);
  const output = formatted.ok ? formatted.value : formatted.error;
  const canCopyOutput = formatted.ok;

  return (
    <div className="modal-backdrop">
      <section
        className="json-tool"
        aria-label="JSON 格式化"
        style={size ? { height: size.height, width: size.width } : undefined}
        onPointerMove={(event) => {
          const start = resizeStart.current;
          if (!start) return;
          setSize({
            width: Math.min(window.innerWidth - 24, Math.max(620, start.width + event.clientX - start.x)),
            height: Math.min(window.innerHeight - 24, Math.max(420, start.height + event.clientY - start.y)),
          });
        }}
        onPointerUp={() => { resizeStart.current = null; }}
      >
        <header>
          <h2>JSON 格式化</h2>
          <button className="icon-button" onClick={onClose} title="关闭" type="button">
            <X size={16} />
          </button>
        </header>
        <div className="json-grid">
          <label>
            原文
            <textarea onChange={(event) => setInput(event.target.value)} value={input} />
          </label>
          <div className="json-result-panel">
            <div className="json-panel-label">结果</div>
            {formatted.ok ? (
              <div className="json-tree" aria-label="格式化结果">
                {formatted.value ? <JsonTree value={formatted.parsed} /> : <span className="json-empty">输入 JSON 后显示格式化结果</span>}
              </div>
            ) : (
              <pre className="json-error" role="alert">{output}</pre>
            )}
          </div>
        </div>
        <footer>
          <button onClick={() => onCopy(input)} type="button">
            <Copy size={16} />
            复制原文
          </button>
          <button className="primary-button" disabled={!canCopyOutput} onClick={() => onCopy(output)} type="button">
            <Copy size={16} />
            复制结果
          </button>
        </footer>
        <button
          aria-label="调整窗口大小"
          className="json-resize-handle"
          onPointerDown={(event) => {
            const rect = event.currentTarget.parentElement?.getBoundingClientRect();
            if (!rect) return;
            resizeStart.current = { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          type="button"
        />
      </section>
    </div>
  );
}

function formatJson(input: string): { ok: true; value: string; parsed: unknown } | { ok: false; error: string } {
  if (!input.trim()) {
    return { ok: true, value: '', parsed: null };
  }
  try {
    const parsed = JSON.parse(input) as unknown;
    return { ok: true, value: JSON.stringify(parsed, null, 2), parsed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'JSON 格式错误' };
  }
}

function JsonTree({ value }: { value: unknown }) {
  return <JsonValue value={value} path="root" />;
}

function JsonValue({ value, path, keyName }: { value: unknown; path: string; keyName?: string }) {
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index), item] as const)
      : Object.entries(value as Record<string, unknown>);
    const [collapsed, setCollapsed] = useState(false);
    const opening = Array.isArray(value) ? '[' : '{';
    const closing = Array.isArray(value) ? ']' : '}';

    return (
      <div className="json-node">
        <div className="json-line">
          <button
            aria-label={collapsed ? '展开节点' : '收起节点'}
            className="json-toggle"
            onClick={() => setCollapsed((current) => !current)}
            type="button"
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          {keyName !== undefined && <><span className="json-key">&quot;{keyName}&quot;</span><span className="json-colon">: </span></>}
          <span className="json-bracket">{opening}</span>
          {collapsed && <span className="json-muted"> {entries.length} 项 </span>}
        </div>
        {!collapsed && (
          <div className="json-children">
            {entries.map(([key, child]) => <JsonValue key={`${path}.${key}`} value={child} path={`${path}.${key}`} keyName={Array.isArray(value) ? undefined : key} />)}
          </div>
        )}
        {!collapsed && <div className="json-line json-closing"><span className="json-toggle-spacer" />{closing}</div>}
      </div>
    );
  }

  const primitiveClass = value === null ? 'json-null' : typeof value === 'string' ? 'json-string' : typeof value === 'number' ? 'json-number' : 'json-boolean';
  const display = value === null ? 'null' : typeof value === 'string' ? `"${value}"` : String(value);
  return (
    <div className="json-line json-leaf">
      <span className="json-toggle-spacer" />
      {keyName !== undefined && <><span className="json-key">&quot;{keyName}&quot;</span><span className="json-colon">: </span></>}
      <span className={primitiveClass}>{display}</span>
    </div>
  );
}
