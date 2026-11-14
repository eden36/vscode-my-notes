import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
export function isMissing(error: unknown): boolean {
  const code = (error as {
    code?: string;
  })?.code;
  return code === 'ENOENT' || code === 'FileNotFound';
}
export function sharedStateDir(): vscode.Uri {
  return vscode.Uri.file(path.join(os.homedir(), '.mynotes'));
}
/** 唯一临时文件与同目录替换避免半写状态和同进程并发冲突。 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), {
    recursive: true
  });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), {
      encoding: 'utf8', flag: 'wx'
    });
    await fs.rename(temporary, file);
  }
  finally {
    await fs.rm(temporary, {
      force: true
    });
  }
}
export interface RunRecord {
  version: 2;
  taskId?: string;
  configVersion?: number;
  trigger?: string;
  lastAttemptAt: number;
  lastSuccessAt: number;
  outcome: 'complete' | 'partial' | 'failed' | 'cancelled';
}
export async function readRunRecord(state: vscode.Uri, key: string): Promise<RunRecord | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(state.fsPath, `run-${key}.json`), 'utf8'));
    if (value.version !== 2 || !Number.isFinite(value.lastAttemptAt) || !Number.isFinite(value.lastSuccessAt) ||
      value.lastAttemptAt < 0 || value.lastSuccessAt < 0 || !['complete', 'partial', 'failed', 'cancelled'].includes(value.outcome)) {
      throw new Error('同步运行记录格式异常。');
    }
    return value as RunRecord;
  }
  catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}
export async function writeRunRecord(state: vscode.Uri, key: string, record: RunRecord): Promise<void> {
  await writeJsonAtomic(path.join(state.fsPath, `run-${key}.json`), record);
}
