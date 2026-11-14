import { createHash } from 'crypto';
import { realpath } from 'fs/promises';
import * as path from 'path';
import type { SyncConfig } from '../config';
/** 标识实际目录，目录联接和符号链接使用同一份本地互斥状态。 */
export async function canonicalNotesPath(location: string): Promise<string> {
  if (!path.isAbsolute(location)) {
    throw new Error('笔记目录必须为绝对路径。');
  }
  return path.normalize(await realpath(location));
}
/** 尚未落盘的文档通过最近存在的父目录解析目录别名。 */
export async function canonicalFilePath(location: string): Promise<string> {
  let existing = path.resolve(location);
  const suffix: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(existing), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(existing) === existing) { throw error; }
      suffix.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
}
export function identityKey(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function normalizeRemotePath(input: string): string {
  const segments = input.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('远端目录不能包含 . 或 .. 路径段。');
  }
  return `/${segments.join('/')}`;
}
/** 目标账号与目录共同决定基线归属，凭据内容仅留在任务内存中。 */
export function syncIdentity(root: string, config: SyncConfig): string {
  const target = config.provider === 'webdav'
    ? [new URL(config.webdav.url).href.replace(/\/+$/, ''), config.webdav.username, normalizeRemotePath(config.webdav.remotePath)]
    : [config.git.remoteUrl, config.git.branch];
  return identityKey([path.normalize(root), config.provider, ...target]);
}
