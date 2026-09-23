import { getCurrentWindow } from '@tauri-apps/api/window';
import { emitTo, listen } from '@tauri-apps/api/event';
import { Check, Copy, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { builtinFeatures, normalizeFeature, splitSequenceSteps } from '../../shared/featureModel';
import { loadCustomFeatures } from '../../shared/promptpadStorage';
import type { AgentType, NormalizedFeatureDef } from '../../shared/types';

interface PluginWindowContext {
  sessionId: string | null;
  sessionName?: string;
  groupId: string | null;
  cwd?: string;
}

interface PluginWindowPageProps {
  pluginId: string;
}

export function PluginWindowPage({ pluginId }: PluginWindowPageProps) {
  const [feature, setFeature] = useState<NormalizedFeatureDef | null>(null);
  const [context, setContext] = useState<PluginWindowContext>({ sessionId: null, groupId: null });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let mounted = true;
    let unlistenContext: (() => void) | undefined;
    void Promise.all([
      loadCustomFeatures(),
      listen<PluginWindowContext>('plugin-window-context', (event) => {
        if (mounted) {
          setContext(event.payload);
        }
      }),
    ]).then(([customFeatures, unlisten]) => {
      if (mounted) {
        unlistenContext = unlisten;
        const features = [...builtinFeatures(), ...customFeatures.map(normalizeFeature)];
        setFeature(features.find((item) => item.id === pluginId) ?? null);
        setLoading(false);
        void emitTo('main', 'plugin-window-ready', pluginId);
      } else {
        unlisten();
      }
    }).catch(() => {
      if (mounted) {
        setLoading(false);
        setMessage('无法读取插件配置');
      }
    });
    return () => {
      mounted = false;
      unlistenContext?.();
    };
  }, [pluginId]);

  const steps = useMemo(() => feature?.type === 'sequence' ? splitSequenceSteps(feature.script) : [], [feature]);

  async function insert(text: string) {
    if (!context.sessionId) {
      setMessage('主窗口当前没有活动会话');
      return;
    }
    await emitTo('main', 'plugin-window-insert', {
      featureId: pluginId,
      sessionId: context.sessionId,
      text,
    });
    setMessage('已插入当前会话输入框');
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setMessage('内容已复制');
  }

  async function close() {
    await getCurrentWindow().close();
  }

  if (loading) {
    return <main className="plugin-window-page"><p className="empty">正在加载插件...</p></main>;
  }
  if (!feature) {
    return <main className="plugin-window-page"><p className="empty">插件不存在或已被删除</p><button className="primary-button" onClick={() => void close()} type="button"><X size={15} />关闭窗口</button></main>;
  }

  const script = feature.script?.trim() ?? '';
  return (
    <main className="plugin-window-page">
      <header className="plugin-window-header" data-tauri-drag-region="true">
        <div>
          <span className="plugin-window-kicker">独立插件页面</span>
          <h1>{feature.name}</h1>
          <p>{feature.description || '暂无简介'}</p>
        </div>
        <button aria-label="关闭插件窗口" className="icon-button" onClick={() => void close()} title="关闭窗口" type="button"><X size={18} /></button>
      </header>
      <section className="plugin-window-context">
        <span>当前会话：{context.sessionName || (context.sessionId ? '已绑定会话' : '未绑定')}</span>
        {context.cwd && <span title={context.cwd}>目录：{context.cwd}</span>}
      </section>
      {steps.length > 0 ? (
        <section className="plugin-window-content">
          <h2>工作流步骤</h2>
          {steps.map((step, index) => (
            <article className="plugin-window-step" key={`${feature.id}-${index}`}>
              <div className="plugin-window-step-title"><strong>步骤 {index + 1}</strong><span>可独立执行</span></div>
              <pre>{step}</pre>
              <div className="plugin-window-actions">
                <button className="primary-button" onClick={() => void insert(step)} type="button"><Check size={15} />插入当前会话</button>
                <button className="secondary-button" onClick={() => void copy(step)} type="button"><Copy size={15} />复制</button>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <section className="plugin-window-content">
          <h2>功能内容</h2>
          {script ? <pre className="plugin-window-script">{script}</pre> : <p className="empty">该内置插件通过独立交互窗口提供功能。</p>}
          {script && <div className="plugin-window-actions"><button className="primary-button" onClick={() => void insert(script)} type="button"><Check size={15} />插入当前会话</button><button className="secondary-button" onClick={() => void copy(script)} type="button"><Copy size={15} />复制内容</button></div>}
        </section>
      )}
      {message && <div className="toast plugin-window-toast" role="status">{message}</div>}
    </main>
  );
}

export function agentLabel(agent: AgentType): string {
  return agent === 'codex' ? 'Codex' : 'Claude';
}
