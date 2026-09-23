import { invoke } from '@tauri-apps/api/core';

export interface RecentChangedFile {
  path: string;
  absolutePath: string;
  name: string;
  extension: string;
  createdMs: number;
  modifiedMs: number;
  size: number;
}

export function scanRecentChanges(rootPath: string, limit = 80): Promise<RecentChangedFile[]> {
  return invoke<RecentChangedFile[]>('scan_recent_changes', { limit, rootPath });
}
