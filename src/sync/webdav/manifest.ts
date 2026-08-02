import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../../log';

export const MANIFEST_VERSION = 1;

/** 上次同步完成时某个文件的状态，作为三方对比的基线 */
export interface ManifestEntry {
  size: number;
  hash: string;
  remoteEtag?: string;
  remoteLastmod?: string;
}

export interface Manifest {
  version: number;
  lastSyncAt?: string;
  files: Record<string, ManifestEntry>;
}

/**
 * absent 表示确实是首次同步，corrupted 表示基线本应存在却读不出来。
 * 两者都会退化成首次同步，但后果完全不同——基线丢失时，本地已删除而远端仍
 * 保留的笔记会被当成「仅远端存在」重新下载回来，必须让用户知道。
 */
export type ManifestStatus = 'ok' | 'absent' | 'corrupted';

export interface ManifestRead {
  manifest: Manifest;
  status: ManifestStatus;
}

export function emptyManifest(): Manifest {
  return { version: MANIFEST_VERSION, files: {} };
}

/**
 * 清单按「服务地址 + 远端路径」区分，切换服务器不会串用旧基线。
 * 存放目录由调用方给出，需与 Profile 无关，且在笔记目录之外。
 */
export function manifestUri(stateDir: vscode.Uri, url: string, remotePath: string): vscode.Uri {
  const key = createHash('sha256').update(`${url} ${remotePath}`).digest('hex').slice(0, 12);
  return vscode.Uri.joinPath(stateDir, `webdav-manifest-${key}.json`);
}

function isNotFound(err: unknown): boolean {
  if (err instanceof vscode.FileSystemError) {
    return err.code === 'FileNotFound';
  }
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export async function readManifest(uri: vscode.Uri): Promise<ManifestRead> {
  let raw: Uint8Array;
  try {
    raw = await vscode.workspace.fs.readFile(uri);
  } catch (err) {
    if (isNotFound(err)) {
      return { manifest: emptyManifest(), status: 'absent' };
    }
    log.warn(`读取同步清单失败：${err instanceof Error ? err.message : String(err)}`);
    return { manifest: emptyManifest(), status: 'corrupted' };
  }

  try {
    const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as Manifest;
    if (parsed?.version !== MANIFEST_VERSION || typeof parsed.files !== 'object' || parsed.files === null) {
      log.warn('同步清单版本不匹配或格式异常');
      return { manifest: emptyManifest(), status: 'corrupted' };
    }
    return { manifest: parsed, status: 'ok' };
  } catch {
    log.warn('同步清单内容无法解析');
    return { manifest: emptyManifest(), status: 'corrupted' };
  }
}

/** 把损坏的清单改名留存，避免下轮同步再次读到它，也便于排查 */
export async function quarantineManifest(uri: vscode.Uri): Promise<void> {
  try {
    await fs.rename(uri.fsPath, `${uri.fsPath}.corrupted-${Date.now()}`);
  } catch {
    // 文件本就不存在或无法改名，不影响后续流程
  }
}

export async function writeManifest(uri: vscode.Uri, manifest: Manifest): Promise<void> {
  manifest.lastSyncAt = new Date().toISOString();
  await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });

  // 先写临时文件再整体替换：多窗口并发写入或写到一半崩溃，都不会留下半截 JSON
  const temp = `${uri.fsPath}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(manifest, null, 2), 'utf8');
  await fs.rename(temp, uri.fsPath);
}

/**
 * 把旧版本存放在 Profile 私有目录中的基线搬到共享目录。
 * 不迁移的话，升级后的首轮同步会被当成首次同步，此前删除的笔记会被重新下载回来。
 */
export async function migrateLegacyManifest(target: vscode.Uri, legacy: vscode.Uri): Promise<boolean> {
  try {
    const raw = await vscode.workspace.fs.readFile(legacy);
    await fs.mkdir(path.dirname(target.fsPath), { recursive: true });
    await fs.writeFile(target.fsPath, Buffer.from(raw));
    log.info('已将同步基线从 Profile 私有目录迁移到共享目录');
    return true;
  } catch {
    // 旧基线不存在或不可读，按首次同步处理即可
    return false;
  }
}
