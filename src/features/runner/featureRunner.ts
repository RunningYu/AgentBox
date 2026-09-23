import { invoke } from '@tauri-apps/api/core';
import { splitSequenceSteps } from '../../shared/featureModel';
import type { NormalizedFeatureDef } from '../../shared/types';

export type FeatureAction =
  | { kind: 'promptpad' }
  | { kind: 'json-format' }
  | { kind: 'url'; url: string }
  | { kind: 'paste'; text: string; appendEnter: boolean }
  | { kind: 'shell'; command: string }
  | { kind: 'system-terminal'; command: string; input?: string };

export function buildFeatureAction(feature: NormalizedFeatureDef): FeatureAction {
  if (feature.id === 'builtin-promptpad') {
    return { kind: 'promptpad' };
  }
  if (feature.id === 'builtin-json-format') {
    return { kind: 'json-format' };
  }

  const script = feature.script ?? '';
  switch (feature.type) {
    case 'agent':
      return { kind: 'system-terminal', command: feature.agent, input: script };
    case 'url':
      return { kind: 'url', url: normalizeUrl(script) };
    case 'snippet':
      return { kind: 'paste', text: script, appendEnter: false };
    case 'sequence':
      return buildSequenceTerminalAction(feature.seqTerm, splitSequenceSteps(script));
    case 'prompt':
    default:
      return { kind: 'paste', text: script, appendEnter: feature.autoRun };
  }
}

export async function runFeatureAction(action: FeatureAction): Promise<string | null> {
  switch (action.kind) {
    case 'url':
      await invoke('open_external_url', { url: action.url });
      return null;
    case 'paste':
      await invoke('set_clipboard_text', { text: action.text });
      try {
        await invoke('paste_clipboard', { appendEnter: action.appendEnter });
      } catch {
        return '已复制到剪贴板。若需要自动粘贴，请在 macOS 系统设置中为 AgentBox 授予辅助功能权限。';
      }
      return null;
    case 'shell': {
      const result = await invoke<{ status: number | null; stdout: string; stderr: string }>('run_shell_command', {
        command: action.command,
      });
      return [result.stdout, result.stderr].filter(Boolean).join('\n');
    }
    case 'system-terminal':
      await invoke('open_system_terminal', { command: action.command, input: action.input ?? null });
      return '已在系统终端中唤起';
    case 'promptpad':
    case 'json-format':
      return null;
  }
}

export function normalizeUrl(raw: string): string {
  const url = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || url.startsWith('mailto:')) {
    return url;
  }
  return `https://${url}`;
}

function buildSequenceTerminalAction(term: string, steps: string[]): FeatureAction {
  const content = steps.join('\n');
  if (term === 'claude' || term === 'codex') {
    return { kind: 'system-terminal', command: term, input: content };
  }
  return { kind: 'system-terminal', command: content };
}
