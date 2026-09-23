import { Channel, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AgentType, ClaudeTranscriptMessage, GuiAgentType, GuiModelType } from '../../shared/types';

export interface PtyOutputEvent {
  sessionId: string;
  generation: string;
  data: string;
}

export interface PtyExitEvent {
  sessionId: string;
  generation: string;
  error?: string | null;
}

type PtyStreamEvent = (PtyOutputEvent & { kind: 'output' }) | (PtyExitEvent & { kind: 'exit' });

const ptyChannels = new Map<string, Channel<PtyStreamEvent>>();
const channelOutputSubscribers = new Set<(event: PtyOutputEvent) => void>();
const channelExitSubscribers = new Set<(event: PtyExitEvent) => void>();

export interface PtyPollResult {
  data: string;
  running: boolean;
  error?: string | null;
}

export interface StartPtyOptions {
  cliSessionId?: string;
  model?: string;
  agentContext?: string;
  resume?: boolean;
  fallbackResume?: boolean;
  cols?: number;
  rows?: number;
}

export interface AgentSkillItem {
  agent: AgentType;
  command: string;
  description: string;
  name: string;
  path: string;
  source: string;
}

export function startPty(
  sessionId: string,
  generation: string,
  agent: AgentType,
  cwd: string,
  options: StartPtyOptions = {},
): Promise<void> {
  const key = `${sessionId}:${generation}`;
  const channel = new Channel<PtyStreamEvent>();
  ptyChannels.set(key, channel);
  channel.onmessage = (event) => {
    if (event.kind === 'output') {
      for (const subscriber of channelOutputSubscribers) {
        subscriber({ sessionId: event.sessionId, generation: event.generation, data: event.data });
      }
      return;
    }
    for (const subscriber of channelExitSubscribers) {
      subscriber({ sessionId: event.sessionId, generation: event.generation, error: event.error });
    }
    if (ptyChannels.get(key) === channel) {
      ptyChannels.delete(key);
    }
  };
  return invoke<void>('start_pty', {
    sessionId,
    generation,
    agent,
    cwd,
    cliSessionId: options.cliSessionId ?? null,
    ...(options.model?.trim() ? { model: options.model.trim() } : {}),
    ...(options.agentContext ? { agentContext: options.agentContext } : {}),
    resume: options.resume ?? false,
    fallbackResume: options.fallbackResume ?? false,
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    onEvent: channel,
  }).catch((error) => {
    if (ptyChannels.get(key) === channel) {
      ptyChannels.delete(key);
    }
    throw error;
  });
}

export function subscribePtyChannel(
  onOutput: (event: PtyOutputEvent) => void,
  onExit: (event: PtyExitEvent) => void,
): () => void {
  channelOutputSubscribers.add(onOutput);
  channelExitSubscribers.add(onExit);
  return () => {
    channelOutputSubscribers.delete(onOutput);
    channelExitSubscribers.delete(onExit);
  };
}

export function findAgentSessionId(agent: AgentType, cwd: string, startedAtMs: number): Promise<string | null> {
  return invoke<string | null>('find_agent_session_id', { agent, cwd, startedAtMs });
}

export function loadClaudeTranscript(cwd: string, cliSessionId: string): Promise<ClaudeTranscriptMessage[]> {
  return invoke<ClaudeTranscriptMessage[]>('load_claude_transcript', { cwd, cliSessionId });
}

export function loadCodexTranscript(cwd: string, cliSessionId: string): Promise<ClaudeTranscriptMessage[]> {
  return invoke<ClaudeTranscriptMessage[]>('load_codex_transcript', { cwd, cliSessionId });
}

export function agentSessionExists(agent: AgentType, cwd: string, cliSessionId: string): Promise<boolean> {
  return invoke<boolean>('agent_session_exists', { agent, cwd, cliSessionId });
}

export function findPtySessionId(
  sessionId: string,
  generation: string,
  agent: AgentType,
  cwd: string,
): Promise<string | null> {
  return invoke<string | null>('find_pty_session_id', { sessionId, generation, agent, cwd });
}

export function writePty(sessionId: string, generation: string, data: string): Promise<void> {
  return invoke('write_pty', { sessionId, generation, data });
}

export function pollPty(sessionId: string, generation: string): Promise<PtyPollResult> {
  return invoke<PtyPollResult>('poll_pty', { sessionId, generation });
}

export function resizePty(
  sessionId: string,
  generation: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke('resize_pty', { sessionId, generation, cols, rows });
}

export function completeGuiMessage(agent: GuiAgentType, model: GuiModelType, cwd: string, prompt: string): Promise<string> {
  return invoke<string>('complete_gui_message', { agent, model, cwd, prompt });
}

export function stopPty(sessionId: string, generation: string): Promise<void> {
  return invoke('stop_pty', { sessionId, generation });
}

export function preparePtyRestart(sessionId: string): Promise<void> {
  return invoke('prepare_pty_restart', { sessionId });
}

export function chooseWorkingDirectory(): Promise<string | null> {
  return invoke<string | null>('choose_working_directory');
}

export function validateWorkingDirectory(cwd: string): Promise<void> {
  return invoke('validate_working_directory_path', { cwd });
}

export function openWorkingDirectory(cwd: string): Promise<void> {
  return invoke('open_working_directory', { cwd });
}

export function getClipboardText(): Promise<string> {
  return invoke<string>('get_clipboard_text');
}

export function setClipboardText(text: string): Promise<void> {
  return invoke('set_clipboard_text', { text });
}

export function listAgentSkills(cwd?: string | null): Promise<AgentSkillItem[]> {
  return invoke<AgentSkillItem[]>('list_agent_skills', { cwd: cwd ?? null });
}

export function listenPtyOutput(handler: (event: PtyOutputEvent) => void): Promise<UnlistenFn> {
  return listen<PtyOutputEvent>('pty-output', (event) => handler(event.payload));
}

export function listenPtyExit(handler: (event: PtyExitEvent) => void): Promise<UnlistenFn> {
  return listen<PtyExitEvent>('pty-exit', (event) => handler(event.payload));
}
