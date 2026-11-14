import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { isMissing, writeJsonAtomic } from '../stateStore';
import { isSyncPath } from '../syncPath';
export const MANIFEST_VERSION = 2;
export interface ManifestEntry {
  size: number;
  hash: string;
  remoteEtag?: string;
  remoteLastmod?: string;
}
export interface PendingAction {
  action: string;
  reason: string;
}
export interface Manifest {
  version: number;
  identity?: string;
  lastSyncAt?: string;
  rebuilding?: boolean;
  files: Record<string, ManifestEntry>;
  pending?: Record<string, PendingAction>;
}
export type ManifestStatus = 'ok' | 'absent' | 'corrupted';
export interface ManifestRead {
  manifest: Manifest;
  status: ManifestStatus;
}
export function emptyManifest(identity?: string): Manifest {
  return {
    version: MANIFEST_VERSION, identity, files: Object.create(null), pending: Object.create(null)
  };
}
/** 完整身份用于新基线，旧地址键仅用于检查升级线索。 */
export function manifestUri(state: vscode.Uri, url: string, remotePath: string, identity?: string): vscode.Uri {
  const key = createHash('sha256').update(`${url} ${remotePath}`).digest('hex').slice(0, 12);
  return vscode.Uri.joinPath(state, identity ? `webdav-v2-${identity}.json` : `webdav-manifest-${key}.json`);
}
export async function readManifest(uri: vscode.Uri, identity?: string): Promise<ManifestRead> {
  let raw: Uint8Array;
  try {
    raw = await vscode.workspace.fs.readFile(uri);
  }
  catch (error) {
    if (isMissing(error)) {
      return {
        status: 'absent', manifest: emptyManifest(identity)
      };
    }
    throw error;
  }
  try {
    const value = JSON.parse(Buffer.from(raw).toString('utf8')) as Manifest;
    if (value.version !== MANIFEST_VERSION || (identity && value.identity !== identity) ||
      !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) {
      throw new Error('同步基线格式或身份不匹配。');
    }
    for (const [relative, entry] of Object.entries(value.files)) {
      if (!isSyncPath(relative) || !entry || typeof entry.hash !== 'string' || !entry.hash ||
        !Number.isFinite(entry.size) || entry.size < 0 ||
        (entry.remoteEtag !== undefined && typeof entry.remoteEtag !== 'string') ||
        (entry.remoteLastmod !== undefined && typeof entry.remoteLastmod !== 'string')) {
        throw new Error('同步基线文件条目无效。');
      }
    }
    if (value.pending !== undefined && (!value.pending || Array.isArray(value.pending) || typeof value.pending !== 'object')) {
      throw new Error('同步基线待核实记录无效。');
    }
    for (const [relative, pending] of Object.entries(value.pending ?? {})) {
      if (!isSyncPath(relative) || !pending || typeof pending.action !== 'string' || typeof pending.reason !== 'string') {
        throw new Error('同步基线待核实条目无效。');
      }
    }
    return {
      status: 'ok', manifest: value
    };
  }
  catch {
    return {
      status: 'corrupted', manifest: emptyManifest(identity)
    };
  }
}
export async function quarantineManifest(uri: vscode.Uri): Promise<void> {
  try {
    await fs.copyFile(uri.fsPath, `${uri.fsPath}.corrupted-${Date.now()}`, 1);
  }
  catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}
export async function writeManifest(uri: vscode.Uri, manifest: Manifest): Promise<void> {
  manifest.lastSyncAt = new Date().toISOString();
  await writeJsonAtomic(uri.fsPath, manifest);
}
/** 只有已经包含可用身份的新格式才允许原样迁移。 */
export async function migrateLegacyManifest(target: vscode.Uri, legacy: vscode.Uri): Promise<boolean> {
  const read = await readManifest(legacy);
  if (read.status !== 'ok') {
    return false;
  }
  await writeManifest(target, read.manifest);
  return true;
}
