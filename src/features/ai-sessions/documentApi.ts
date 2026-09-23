import { invoke } from '@tauri-apps/api/core';

export interface DocumentNode {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  extension?: string | null;
  children?: DocumentNode[];
}

export interface DocumentFileContent {
  path: string;
  name: string;
  extension: string;
  content: string;
  size: number;
  binary?: number[];
  previewKind?: 'text' | 'markdown' | 'docx' | 'office-html' | 'pdf' | 'image';
  renderedHtml?: string | null;
}

export function chooseDocumentDirectory(): Promise<string | null> {
  return invoke<string | null>('choose_document_directory');
}

export function chooseDocumentFile(): Promise<string | null> {
  return invoke<string | null>('choose_document_file');
}

export function listDocumentTree(rootPath: string): Promise<DocumentNode[]> {
  return invoke<DocumentNode[]>('list_document_tree', { rootPath });
}

export function readDocumentFile(rootPath: string, relativePath: string): Promise<DocumentFileContent> {
  return invoke<DocumentFileContent>('read_document_file', { rootPath, relativePath });
}

export function readContextFile(path: string): Promise<DocumentFileContent> {
  return invoke<DocumentFileContent>('read_context_file', { path });
}
