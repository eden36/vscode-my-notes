import * as path from 'path';
import * as vscode from 'vscode';
import { isMissing } from '../sync/stateStore';
import { isNoteFile, type NotesConfig } from '../config';

/** Windows 保留的设备名，用作文件名会直接失败 */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * 校验用户输入的文件/文件夹名。返回 undefined 表示合法，否则返回中文错误说明。
 * 统一按 Windows 的限制校验，避免笔记同步到 Windows 设备后无法检出。
 */
export function validateEntryName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) {
    return '名称不能为空';
  }
  if (trimmed === '.' || trimmed === '..') {
    return '名称无效';
  }
  if (/[\\/:*?"<>|]/.test(trimmed)) {
    return '名称不能包含 \\ / : * ? " < > | 字符';
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(trimmed)) {
    return '名称不能包含控制字符';
  }
  if (/[. ]$/.test(trimmed)) {
    return '名称不能以点或空格结尾';
  }
  if (WINDOWS_RESERVED.has(path.parse(trimmed).name.toLowerCase())) {
    return '该名称为系统保留名，请换一个';
  }
  if (trimmed.length > 200) {
    return '名称过长';
  }
  return undefined;
}

export async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

export async function isDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return (stat.type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

export interface DirectoryEntries {
  folders: vscode.Uri[];
  notes: vscode.Uri[];
}

/** 读取单层目录，过滤隐藏项与非笔记扩展名，并按「文件夹在前、名称升序」排序 */
export async function readNoteDirectory(dir: vscode.Uri, cfg: NotesConfig): Promise<DirectoryEntries> {
  const entries = await vscode.workspace.fs.readDirectory(dir);
  const folders: string[] = [];
  const notes: string[] = [];

  for (const [name, type] of entries) {
    if (name.startsWith('.')) {
      continue;
    }
    if (type & vscode.FileType.Directory) {
      folders.push(name);
    } else if (type & vscode.FileType.File) {
      if (isNoteFile(name, cfg)) {
        notes.push(name);
      }
    }
  }

  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  folders.sort(byName);
  notes.sort(byName);

  return {
    folders: folders.map((name) => vscode.Uri.joinPath(dir, name)),
    notes: notes.map((name) => vscode.Uri.joinPath(dir, name)),
  };
}

/** 递归收集全部笔记，返回相对根目录的路径（用于检索命令） */
export async function listNotesRecursive(root: vscode.Uri, cfg: NotesConfig): Promise<{ uri: vscode.Uri; relativePath: string }[]> {
  const result: { uri: vscode.Uri; relativePath: string }[] = [];

  async function walk(dir: vscode.Uri): Promise<void> {
    const { folders, notes } = await readNoteDirectory(dir, cfg);
    for (const note of notes) {
      result.push({
        uri: note,
        relativePath: path.relative(root.fsPath, note.fsPath).split(path.sep).join('/'),
      });
    }
    for (const folder of folders) {
      await walk(folder);
    }
  }

  await walk(root);
  return result;
}
