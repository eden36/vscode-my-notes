export { SyncLock } from './syncLock';
export { sharedStateDir } from './stateStore';
import { identityKey } from './syncIdentity';
import { readRunRecord, writeRunRecord } from './stateStore';
import * as path from 'path';
import type * as vscode from 'vscode';
/** 已归一化目录供兼容调用与测试使用。 */
export function notesKey(location: string): string {
  const normalized = path.normalize(location);
  return identityKey(process.platform === 'win32' ? normalized.toLowerCase() : normalized);
}
export async function readLastSyncAt(state: vscode.Uri, key: string): Promise<number> {
  return (await readRunRecord(state, key))?.lastSuccessAt ?? 0;
}
export async function writeLastSyncAt(state: vscode.Uri, key: string, value: number): Promise<void> {
  await writeRunRecord(state, key, {
    version: 2, lastAttemptAt: value, lastSuccessAt: value, outcome: 'complete'
  });
}
