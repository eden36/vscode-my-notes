import type * as vscode from 'vscode';

export interface ConflictInfo {
  /** 冲突笔记相对笔记根目录的路径 */
  relativePath: string;
  /** 保留下来的另一方内容所在文件，通常是冲突副本，也可能就是原文件 */
  copyUri: vscode.Uri;
  /** 面向用户的一句话说明，用于日志与提示 */
  description: string;
}

export interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  deletedLocal: string[];
  deletedRemote: string[];
  conflicts: ConflictInfo[];
  /** 单个文件处理失败不中断整轮同步，失败原因收集在此 */
  failures: { relativePath: string; reason: string }[];
  /** 同步本身成功、但需要用户知晓的情况，例如基线丢失导致退化为首次同步 */
  warnings: string[];
}

export function emptyResult(): SyncResult {
  return {
    uploaded: [],
    downloaded: [],
    deletedLocal: [],
    deletedRemote: [],
    conflicts: [],
    failures: [],
    warnings: [],
  };
}

export function isNoopResult(result: SyncResult): boolean {
  return (
    result.uploaded.length === 0 &&
    result.downloaded.length === 0 &&
    result.deletedLocal.length === 0 &&
    result.deletedRemote.length === 0 &&
    result.conflicts.length === 0 &&
    result.failures.length === 0 &&
    result.warnings.length === 0
  );
}

export interface SyncContext {
  /** 笔记根目录 */
  root: vscode.Uri;
  /** 本设备名称，用于提交信息与冲突文件命名 */
  deviceName: string;
  /** 存放同步基线的目录，与 Profile 无关，多个窗口共用同一份 */
  stateUri: vscode.Uri;
  /** 旧版本存放基线的 Profile 私有目录，仅用于一次性迁移 */
  legacyStateUri: vscode.Uri;
  token: vscode.CancellationToken;
  /** 向进度条汇报当前步骤 */
  report(message: string): void;
}

export interface SyncProvider {
  readonly id: 'git' | 'webdav';
  readonly displayName: string;
  /** 检查配置与运行环境，不满足时抛出面向用户的中文错误 */
  validate(): Promise<void>;
  /** 实际连一次远端，返回可展示给用户的成功说明；失败时抛出中文错误 */
  testConnection(): Promise<string>;
  sync(ctx: SyncContext): Promise<SyncResult>;
}

/** 配置缺失、依赖不可用等可直接展示给用户的错误 */
export class SyncConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncConfigError';
  }
}
