import { invoke } from '@tauri-apps/api/core';
import type { AiSessionRecord, AiWorkspaceArchive, FeatureDef, Prefs, WorkflowProject } from './types';

const FEATURES_FILE = 'features.json';
const PREFS_FILE = 'prefs.json';
const WORKFLOW_PROJECTS_FILE = 'workflow_projects.json';
const AI_SESSIONS_FILE = 'ai_sessions.json';

export async function loadCustomFeatures(): Promise<FeatureDef[]> {
  return readJsonFile<FeatureDef[]>(FEATURES_FILE, []);
}

export async function saveCustomFeatures(features: FeatureDef[]): Promise<void> {
  await writeJsonFile(FEATURES_FILE, features);
}

export async function loadPrefs(): Promise<Prefs> {
  return readJsonFile<Prefs>(PREFS_FILE, { favorites: [], order: [] });
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  await writeJsonFile(PREFS_FILE, prefs);
}

export async function loadWorkflowProjects(): Promise<WorkflowProject[]> {
  return readJsonFile<WorkflowProject[]>(WORKFLOW_PROJECTS_FILE, []);
}

export async function saveWorkflowProjects(projects: WorkflowProject[]): Promise<void> {
  await writeJsonFile(WORKFLOW_PROJECTS_FILE, projects);
}

export async function loadAiSessions(): Promise<unknown> {
  return readJsonFile<unknown>(AI_SESSIONS_FILE, []);
}

export async function saveAiSessions(sessions: AiSessionRecord[]): Promise<void> {
  await writeJsonFile(AI_SESSIONS_FILE, sessions);
}

export function loadAiWorkspace(): Promise<AiWorkspaceArchive> {
  return invoke<AiWorkspaceArchive>('load_ai_workspace');
}

export function saveAiWorkspace(archive: AiWorkspaceArchive): Promise<void> {
  return invoke('save_ai_workspace', { archive });
}

export function loadAiSessionHistory(sessionId: string): Promise<string> {
  return invoke<string>('load_ai_session_history', { sessionId });
}

export function appendAiSessionHistory(sessionId: string, data: string): Promise<void> {
  return invoke('append_ai_session_history', { sessionId, data });
}

export function deleteAiSessionHistories(sessionIds: string[]): Promise<void> {
  return invoke('delete_ai_session_histories', { sessionIds });
}

export function commitAiSessionDeletion(
  archive: AiWorkspaceArchive,
  sessionIds: string[],
): Promise<void> {
  return invoke('commit_ai_session_deletion', { archive, sessionIds });
}

async function readJsonFile<T>(name: string, fallback: T): Promise<T> {
  const raw = await invoke<string>('read_promptpad_file', { name });
  if (!raw.trim()) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(name: string, value: unknown): Promise<void> {
  await invoke('write_promptpad_file', {
    name,
    content: `${JSON.stringify(value, null, 2)}\n`,
  });
}
