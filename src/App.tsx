import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AiWorkspace } from './features/ai-sessions/AiWorkspace';
import { JsonFormatter } from './features/json/JsonFormatter';
import { PromptPad } from './features/promptpad/PromptPad';
import { buildFeatureAction, runFeatureAction } from './features/runner/featureRunner';
import { FeatureEditor } from './features/toolbox/FeatureEditor';
import { DeleteFeatureDialog } from './features/toolbox/FeatureItemMenu';
import { Toolbox } from './features/toolbox/Toolbox';
import { ToolboxTransferDialog } from './features/toolbox/ToolboxTransferDialog';
import { builtinFeatures, normalizeFeature } from './shared/featureModel';
import { loadCustomFeatures, loadPrefs, saveCustomFeatures, savePrefs } from './shared/promptpadStorage';
import type { FeatureDef, NormalizedFeatureDef, Prefs } from './shared/types';
import { normalizeQuickPalettePrefs } from './features/quick-palette/quickPaletteModel';
import { PluginWindowPage } from './features/plugin-windows/PluginWindowPage';
import { AgentCenterDemo, type AgentDefinition, type AgentSessionPreset } from './features/ai-sessions/AgentCenterDemo';
import { useModalFocus } from './features/ai-sessions/modalFocus';
import { FileWorkspace } from './features/files/FileWorkspace';

const DEFAULT_PREFS: Prefs = { favorites: [], order: [] };
const USER_GUIDE_URL = 'https://juejin.cn/spost/7686174631262453801';

export function App() {
  const pluginWindowId = new URLSearchParams(window.location.search).get('plugin-window');
  if (pluginWindowId) {
    return <PluginWindowPage pluginId={pluginWindowId} />;
  }
  const [workspace, setWorkspace] = useState<'toolbox' | 'ai' | 'agents' | 'file'>('ai');
  const [customFeatures, setCustomFeatures] = useState<NormalizedFeatureDef[]>([]);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [editing, setEditing] = useState<NormalizedFeatureDef | null>(null);
  const [deletingFeature, setDeletingFeature] = useState<NormalizedFeatureDef | null>(null);
  const [transferFeatures, setTransferFeatures] = useState<NormalizedFeatureDef[] | null>(null);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [agentPreset, setAgentPreset] = useState<AgentSessionPreset | null>(null);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const promptSubmitRef = useRef<((text: string) => Promise<void> | void) | null>(null);

  const features = useMemo(() => [...builtinFeatures(), ...customFeatures], [customFeatures]);
  const normalizedPrefs = useMemo(() => ensurePrefs(prefs, features), [features, prefs]);

  useEffect(() => {
    void loadInitialData();
  }, []);

  useEffect(() => {
    let disposed = false;
    const pollCloseRequest = () => {
      void invoke<boolean>('take_main_window_close_request')
        .then((pending) => {
          if (pending && !disposed) {
            setCloseDialogOpen(true);
          }
        })
        .catch(() => undefined);
    };
    pollCloseRequest();
    const timer = window.setInterval(pollCloseRequest, 250);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | undefined;
    let currentWindow: ReturnType<typeof getCurrentWindow>;
    try {
      currentWindow = getCurrentWindow();
    } catch {
      return () => {
        disposed = true;
      };
    }
    void currentWindow.onCloseRequested((event) => {
      event.preventDefault();
      if (!disposed) {
        setCloseDialogOpen(true);
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        dispose = unlisten;
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
      dispose?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | undefined;
    void listen('main-window-close-requested', () => {
      if (!disposed) {
        setCloseDialogOpen(true);
      }
    }, { target: 'main' }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        dispose = unlisten;
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
      dispose?.();
    };
  }, []);

  async function loadInitialData() {
    try {
      const [loadedFeatures, loadedPrefs] = await Promise.all([loadCustomFeatures(), loadPrefs()]);
      setCustomFeatures(loadedFeatures.map(normalizeFeature));
      setPrefs(loadedPrefs);
    } catch (error) {
      if (hasTauriRuntime()) {
        setMessage(error instanceof Error ? error.message : '读取本地配置失败');
      }
    } finally {
      setLoading(false);
    }
  }

  async function updatePrefs(next: Prefs) {
    const safePrefs = ensurePrefs({ ...prefs, ...next }, features);
    setPrefs(safePrefs);
    await savePrefs(safePrefs);
  }

  async function saveFeature(feature: NormalizedFeatureDef) {
    const next = customFeatures.some((item) => item.id === feature.id)
      ? customFeatures.map((item) => (item.id === feature.id ? feature : item))
      : [...customFeatures, feature];
    setCustomFeatures(next);
    await saveCustomFeatures(next.map(stripNormalizedFields));
    setEditing(null);
  }

  async function deleteFeature(feature: NormalizedFeatureDef) {
    const next = customFeatures.filter((item) => item.id !== feature.id);
    setCustomFeatures(next);
    await saveCustomFeatures(next.map(stripNormalizedFields));
    await updatePrefs({
      favorites: normalizedPrefs.favorites.filter((id) => id !== feature.id),
      order: normalizedPrefs.order.filter((id) => id !== feature.id),
    });
    setDeletingFeature(null);
  }

  async function applyImportedToolbox(nextFeatures: NormalizedFeatureDef[], nextPrefs: Prefs) {
    setCustomFeatures(nextFeatures);
    const safePrefs = ensurePrefs({ ...prefs, ...nextPrefs }, [...builtinFeatures(), ...nextFeatures]);
    setPrefs(safePrefs);
    await Promise.all([
      saveCustomFeatures(nextFeatures.map(stripNormalizedFields)),
      savePrefs(safePrefs),
    ]);
  }

  async function invokeFeature(feature: NormalizedFeatureDef) {
    const action = buildFeatureAction(feature);
    if (action.kind === 'promptpad') {
      promptSubmitRef.current = null;
      setPromptOpen(true);
      return;
    }
    if (action.kind === 'json-format') {
      setJsonOpen(true);
      return;
    }
    const result = await runFeatureAction(action);
    setMessage(result || `${feature.name} 已执行`);
  }

  async function invokeAiTool(feature: NormalizedFeatureDef, insertText: (text: string) => void) {
    const action = buildFeatureAction(feature);
    if (action.kind === 'promptpad') {
      promptSubmitRef.current = (text) => {
        insertText(text);
        setMessage('已填入输入框');
      };
      setPromptOpen(true);
      return;
    }
    if (action.kind === 'json-format') {
      setJsonOpen(true);
      return;
    }
    const result = await runFeatureAction(action);
    setMessage(result || `${feature.name} 已执行`);
  }

  async function pasteText(text: string, appendEnter: boolean) {
    if (promptSubmitRef.current) {
      await promptSubmitRef.current(text);
      return;
    }
    const result = await runFeatureAction({ kind: 'paste', text, appendEnter });
    setMessage(result || '已发送');
  }

  function closePromptPad() {
    promptSubmitRef.current = null;
    setPromptOpen(false);
  }

  async function copyText(text: string) {
    await invoke('set_clipboard_text', { text });
    setMessage('已复制到剪贴板');
  }

  async function openUserGuide() {
    try {
      await invoke('open_external_url', { url: USER_GUIDE_URL });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法打开使用文档');
    }
  }

  async function hideMainWindow() {
    try {
      await invoke('hide_main_window');
      setCloseDialogOpen(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法收起 App');
    }
  }

  async function exitApp() {
    try {
      await invoke('exit_app');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法关闭 App');
    }
  }

  function createFeature() {
    setEditing(
      normalizeFeature({
        id: `custom-${Date.now()}`,
        name: '',
        description: '',
        script: '',
        extra: '',
        builtin: false,
        type: 'prompt',
      }),
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <div className="app-brand">
            <h1>AgentBox</h1>
            <button
              aria-label="打开 AgentBox 使用文档"
              className="app-guide-button"
              onClick={() => void openUserGuide()}
              title="打开使用文档"
              type="button"
            >
              <span aria-hidden="true">🌍</span>
            </button>
          </div>
        </div>
        <div className="app-header-actions">
          <button aria-label="全局搜索" className="terminal-search-button app-global-search-button" onClick={() => setGlobalSearchOpen(true)} title="全局搜索 Cmd+K" type="button">
            <Search size={15} />
            <span>搜索</span>
            <kbd>⌘K</kbd>
          </button>
          <nav aria-label="工作区切换" className="segmented workspace-switch">
            <button className={workspace === 'ai' ? 'active' : ''} onClick={() => setWorkspace('ai')} type="button">
              AI 工作台
            </button>
            <button className={workspace === 'agents' ? 'active' : ''} onClick={() => setWorkspace('agents')} type="button">
              Agent 中心
            </button>
            <button className={workspace === 'toolbox' ? 'active' : ''} onClick={() => setWorkspace('toolbox')} type="button">
              工具箱
            </button>
            <button className={workspace === 'file' ? 'active' : ''} onClick={() => setWorkspace('file')} type="button">
              File
            </button>
          </nav>
        </div>
      </header>

      <div className="workspace-panel" hidden={workspace !== 'toolbox'}>
        {loading ? (
          <p className="empty">正在读取 ~/.agentbox 配置</p>
        ) : (
          <Toolbox
            features={features}
            prefs={normalizedPrefs}
            onCreate={createFeature}
            onDelete={setDeletingFeature}
            onEdit={setEditing}
            onInvoke={invokeFeature}
            onPrefsChange={updatePrefs}
            onTransfer={setTransferFeatures}
          />
        )}
      </div>

      <div className="workspace-panel" hidden={workspace !== 'ai'}>
        <AiWorkspace
          agentPreset={agentPreset}
          onAgentPresetConsumed={() => setAgentPreset(null)}
          features={features}
          globalSearchOpen={globalSearchOpen}
          onDeleteFeature={setDeletingFeature}
          onEditFeature={setEditing}
          onGlobalSearchOpenChange={setGlobalSearchOpen}
          onMessage={setMessage}
          onPrefsChange={updatePrefs}
          onToolInvoke={invokeAiTool}
          prefs={normalizedPrefs}
        />
      </div>

      <div className="workspace-panel" hidden={workspace !== 'agents'}>
        <AgentCenterDemo onBack={() => setWorkspace('ai')} onCreateSession={(agent) => { setAgentPreset(agentToSessionPreset(agent)); setWorkspace('ai'); }} />
      </div>

      <div className="workspace-panel" hidden={workspace !== 'file'}>
        <FileWorkspace onBack={() => setWorkspace('ai')} onMessage={setMessage} />
      </div>

      {message && (
        <button className="toast" onClick={() => setMessage(null)} type="button">
          {message}
        </button>
      )}

      {promptOpen && (
        <PromptPad
          onClose={closePromptPad}
          onSubmit={pasteText}
          snippets={customFeatures.filter((feature) => feature.type === 'snippet')}
        />
      )}

      {jsonOpen && <JsonFormatter onClose={() => setJsonOpen(false)} onCopy={copyText} />}

      {editing && (
        <FeatureEditor
          canEditType={!customFeatures.some((feature) => feature.id === editing.id)}
          onCancel={() => setEditing(null)}
          onChange={setEditing}
          onSave={() => saveFeature(editing)}
          value={editing}
        />
      )}

      {deletingFeature && (
        <DeleteFeatureDialog
          name={deletingFeature.name}
          onCancel={() => setDeletingFeature(null)}
          onConfirm={() => deleteFeature(deletingFeature)}
        />
      )}

      {transferFeatures && (
        <ToolboxTransferDialog
          customFeatures={customFeatures}
          filteredFeatures={transferFeatures}
          onApplyImport={applyImportedToolbox}
          onClose={() => setTransferFeatures(null)}
          onMessage={setMessage}
          prefs={normalizedPrefs}
        />
      )}

      {closeDialogOpen && (
        <CloseAppDialog
          onCancel={() => setCloseDialogOpen(false)}
          onExit={() => void exitApp()}
          onHide={() => void hideMainWindow()}
        />
      )}
    </main>
  );
}

function CloseAppDialog({ onCancel, onExit, onHide }: { onCancel: () => void; onExit: () => void; onHide: () => void }) {
  const { dialogRef, initialFocusRef } = useModalFocus<HTMLElement, HTMLButtonElement>(onCancel);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <section aria-labelledby="close-app-title" aria-modal="true" className="session-dialog close-app-dialog" ref={dialogRef} role="dialog">
        <h2 id="close-app-title">关闭 AgentBox</h2>
        <p>请选择关闭窗口后的处理方式。</p>
        <footer>
          <button onClick={onCancel} ref={initialFocusRef} type="button">取消</button>
          <button onClick={onHide} type="button">收起 App</button>
          <button className="danger-button" onClick={onExit} type="button">关闭退出 App</button>
        </footer>
      </section>
    </div>
  );
}

function agentToSessionPreset(agent: AgentDefinition): AgentSessionPreset {
  return {
    name: agent.name,
    agent: agent.type,
    model: agent.model,
    cwd: agent.cwd,
    guiAgent: agent.guiAgent,
    guiModel: agent.guiModel,
    agentConfig: {
      agentId: agent.id,
      agentName: agent.name,
      model: agent.model,
      systemPrompt: agent.prompt,
      behaviorRules: agent.behaviorRules,
      skills: agent.skillNames ?? agent.capabilities,
      knowledgeBases: agent.knowledgeBases,
      mcps: agent.mcps,
    },
  };
}

function hasTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function ensurePrefs(prefs: Prefs, features: NormalizedFeatureDef[]): Prefs {
  const ids = features.map((feature) => feature.id);
  const order = [...prefs.order.filter((id) => ids.includes(id)), ...ids.filter((id) => !prefs.order.includes(id))];
  const favorites = prefs.favorites.filter((id) => ids.includes(id));
  return normalizeQuickPalettePrefs({ ...prefs, favorites, order });
}

function stripNormalizedFields(feature: NormalizedFeatureDef): FeatureDef {
  return {
    id: feature.id,
    name: feature.name,
    description: feature.description,
    script: feature.script,
    extra: feature.extra,
    builtin: false,
    type: feature.type,
    agent: feature.agent,
    autoRun: feature.autoRun,
    seqRule: feature.seqRule,
    seqTerm: feature.seqTerm,
  };
}
