import { invoke } from '@tauri-apps/api/core';

export interface GitChangedFile {
  path: string;
  status: string;
  summary: string;
  modifiedMs?: number | null;
}

export interface GitStatusSummary {
  root: string;
  branch: string;
  files: GitChangedFile[];
}

export interface GitRootInfo {
  root: string;
  name: string;
  branch: string;
}

export interface GitDiffResult {
  path: string;
  diff: string;
}

export function listGitRoots(cwd: string): Promise<GitRootInfo[]> {
  return invoke<GitRootInfo[]>('list_git_roots', { cwd });
}

export function listGitStatus(cwd: string): Promise<GitStatusSummary> {
  return invoke<GitStatusSummary>('list_git_status', { cwd });
}

export function readGitDiff(cwd: string, path: string): Promise<GitDiffResult> {
  return invoke<GitDiffResult>('read_git_diff', { cwd, path });
}
