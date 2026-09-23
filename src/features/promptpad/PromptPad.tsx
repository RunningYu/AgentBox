import { Copy, Play, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { NormalizedFeatureDef } from '../../shared/types';

interface PromptPadProps {
  snippets: NormalizedFeatureDef[];
  onClose: () => void;
  onSubmit: (text: string, appendEnter: boolean) => Promise<void>;
  submitMode?: 'default' | 'copy';
}

export function PromptPad({ snippets, onClose, onSubmit, submitMode = 'default' }: PromptPadProps) {
  const [text, setText] = useState('');
  const usableSnippets = useMemo(() => snippets.filter((feature) => feature.type === 'snippet'), [snippets]);

  function insertSnippet(id: string) {
    const snippet = usableSnippets.find((feature) => feature.id === id);
    if (!snippet?.script) {
      return;
    }
    setText((current) => `${current}${snippet.script}`);
  }

  async function finish(appendEnter: boolean) {
    if (!text.trim()) {
      return;
    }
    await onSubmit(text, appendEnter);
    onClose();
  }

  return (
    <div className="modal-backdrop">
      <section className="promptpad" aria-label="PromptPad">
        <header>
          <h2>PromptPad</h2>
          <button className="icon-button" onClick={onClose} title="关闭" type="button">
            <X size={16} />
          </button>
        </header>
        <textarea
          autoFocus
          onChange={(event) => setText(event.target.value)}
          placeholder="输入提示词、命令或任意文本"
          value={text}
        />
        <footer>
          <select aria-label="插入片段" defaultValue="" onChange={(event) => insertSnippet(event.target.value)}>
            <option value="" disabled>
              插入片段
            </option>
            {usableSnippets.map((snippet) => (
              <option key={snippet.id} value={snippet.id}>
                {snippet.name}
              </option>
            ))}
          </select>
          <div className="footer-actions">
            {submitMode === 'copy' ? (
              <button className="primary-button" onClick={() => finish(false)} type="button">
                <Copy size={16} />
                复制内容
              </button>
            ) : (
              <>
                <button onClick={() => finish(false)} type="button">
                  <Copy size={16} />
                  仅粘贴
                </button>
                <button className="primary-button" onClick={() => finish(true)} type="button">
                  <Play size={16} />
                  粘贴并执行
                </button>
              </>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
