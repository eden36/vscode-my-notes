import * as path from 'path';
import * as vscode from 'vscode';
import { exists } from '../notes/noteFs';
import { conflictFileName } from './conflictName';

export { conflictFileName, formatTimestamp, isConflictFileName } from './conflictName';

/** 在原文件同目录下生成一个尚未被占用的冲突副本路径 */
export async function resolveConflictUri(
  root: vscode.Uri,
  relativePath: string,
  deviceName: string,
  date = new Date(),
): Promise<vscode.Uri> {
  const dir = path.posix.dirname(relativePath);
  const name = path.posix.basename(relativePath);
  const parent = dir === '.' ? root : vscode.Uri.joinPath(root, ...dir.split('/'));

  const baseName = conflictFileName(name, deviceName, date);
  let candidate = vscode.Uri.joinPath(parent, baseName);
  // 同一秒内对同一文件产生多个冲突副本时依次加序号，避免互相覆盖
  for (let i = 2; (await exists(candidate)) && i < 100; i++) {
    const ext = path.extname(baseName);
    const stem = ext ? baseName.slice(0, -ext.length) : baseName;
    candidate = vscode.Uri.joinPath(parent, `${stem}-${i}${ext}`);
  }
  return candidate;
}
