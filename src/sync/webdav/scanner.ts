import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { isSyncPath } from '../syncPath';

export interface LocalFile {
  size: number;
  /** 文件内容的 sha256，用于可靠地判断内容是否变化 */
  hash: string;
}

/** 不参与同步的目录：版本库元数据与系统目录 */
const SKIPPED_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '$RECYCLE.BIN']);

/** 不参与同步的文件：各系统自动生成的杂项 */
const SKIPPED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export function hashContent(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 递归扫描笔记目录，返回「相对路径 → 指纹」。
 *
 * 同步覆盖目录下所有文件而不仅是配置的笔记扩展名，
 * 否则笔记引用的图片等附件会在其他设备上缺失。
 */
export async function scanLocal(root: vscode.Uri): Promise<Map<string, LocalFile>> {
  const files = new Map<string, LocalFile>();

  async function walk(dir: vscode.Uri, prefix: string): Promise<void> {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    for (const [name, type] of entries) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (!isSyncPath(relativePath) || (type & vscode.FileType.SymbolicLink)) {
        continue;
      }
      if (type & vscode.FileType.Directory) {
        if (SKIPPED_DIRS.has(name)) {
          continue;
        }
        await walk(vscode.Uri.joinPath(dir, name), relativePath);
      } else if (type & vscode.FileType.File) {
        if (SKIPPED_FILES.has(name)) {
          continue;
        }
        const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name));
        files.set(relativePath, { size: content.byteLength, hash: hashContent(content) });
      }
    }
  }

  await walk(root, '');
  return files;
}
