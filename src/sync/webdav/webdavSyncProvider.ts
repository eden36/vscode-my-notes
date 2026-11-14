import type { WebDAVClient } from 'webdav' with { 'resolution-mode': 'import' };
import * as vscode from 'vscode';
import { getSyncConfig, type SyncConfig } from '../../config';
import { log } from '../../log';
import { getSecretFor } from '../secrets';
import { canonicalNotesPath, normalizeRemotePath, syncIdentity } from '../syncIdentity';
import { assertSyncActive, SyncConfigError, type SyncContext, type SyncProvider, type SyncResult } from '../syncProvider';
import { isMissing } from '../stateStore';
import { isSafeRelativePath, isSyncPath } from '../syncPath';
import { ActionExecutor } from './actionExecutor';
import { planSync, type RemoteFile } from './diff';
import { manifestUri, quarantineManifest, readManifest, writeManifest } from './manifest';
import { scanLocal } from './scanner';
import { requestSignal } from './webdavTransport';
export { ActionExecutor } from './actionExecutor';
export { normalizeRemotePath } from '../syncIdentity';
export class WebdavSyncProvider implements SyncProvider {
  readonly id = 'webdav' as const;
  readonly displayName = 'WebDAV';
  private credential: Promise<string | undefined> | undefined;
  constructor(private readonly context: vscode.ExtensionContext, private readonly config: Readonly<SyncConfig> = getSyncConfig(), private readonly clientFactory?: () => Promise<WebDAVClient>) {
  }
  private password(): Promise<string | undefined> {
    this.credential ??= getSecretFor(this.context, 'webdav', this.config);
    return this.credential;
  }
  async validate(): Promise<void> {
    if (!this.config.webdav.url) {
      throw new SyncConfigError('未配置 WebDAV 服务地址。');
    }
    const url = new URL(this.config.webdav.url);
    if (!['https:', 'http:'].includes(url.protocol)) {
      throw new SyncConfigError('WebDAV 地址必须使用 HTTP 或 HTTPS。');
    }
    if (!this.config.webdav.username) {
      throw new SyncConfigError('未配置 WebDAV 用户名。');
    }
    if (!(await this.password())) {
      throw new SyncConfigError('未设置当前 WebDAV 账号的密码，请在设置页重新录入。');
    }
  }
  async testConnection(): Promise<string> {
    await this.validate();
    const root = normalizeRemotePath(this.config.webdav.remotePath);
    const client = await this.createClient();
    const exists = await client.exists(root, { signal: AbortSignal.timeout(30_000) });
    return exists ? `连接成功，远端目录「${root}」已存在。` : `连接成功，首次同步时将创建远端目录「${root}」。`;
  }
  private async createClient(): Promise<WebDAVClient> {
    if (this.clientFactory) {
      return this.clientFactory();
    }
    const password = await this.password();
    const { createClient } = await import('webdav');
    return createClient(this.config.webdav.url, {
      username: this.config.webdav.username, password: password ?? '',
      maxBodyLength: Infinity, maxContentLength: Infinity,
    });
  }
  async sync(ctx: SyncContext): Promise<SyncResult> {
    const cfg = this.config;
    const remoteRoot = normalizeRemotePath(cfg.webdav.remotePath);
    const root = await canonicalNotesPath(ctx.root.fsPath);
    const identity = ctx.identity ?? syncIdentity(root, {
      ...cfg, provider: 'webdav'
    });
    const client = await this.createClient();
    assertSyncActive(ctx);
    if (!(await client.exists(remoteRoot, {
      signal: requestSignal(ctx)
    }))) {
      assertSyncActive(ctx);
      await client.createDirectory(remoteRoot, {
        recursive: true, signal: requestSignal(ctx)
      });
    }
    ctx.report('扫描本地笔记');
    const local = await scanLocal(ctx.root);
    assertSyncActive(ctx);
    ctx.report('读取远端列表');
    const { data: contents } = await client.getDirectoryContents(remoteRoot, {
      deep: true, details: true, signal: requestSignal(ctx)
    });
    assertSyncActive(ctx);
    const remote = new Map<string, RemoteFile>();
    const prefix = remoteRoot === '/' ? '/' : `${remoteRoot}/`;
    for (const entry of contents) {
      if (entry.type !== 'file' || !entry.filename.startsWith(prefix)) {
        continue;
      }
      const relative = entry.filename.slice(prefix.length);
      if (!isSafeRelativePath(relative)) {
        throw new SyncConfigError(`远端包含无效或受保护的同步路径：${entry.filename}`);
      }
      if (!isSyncPath(relative)) {
        continue;
      }
      // 原始属性保留引号和 W/ 前缀，客户端的简化字段会移除引号。
      const etag = entry.props?.getetag;
      remote.set(relative, {
        size: entry.size, etag: typeof etag === 'string' ? etag : undefined, lastmod: entry.lastmod
      });
    }
    const uri = manifestUri(ctx.stateUri, cfg.webdav.url, remoteRoot, identity);
    const read = await readManifest(uri, identity);
    const manifest = read.manifest;
    const warnings: string[] = [];
    if (read.status === 'corrupted') {
      await quarantineManifest(uri);
      manifest.rebuilding = true;
      warnings.push('同步基线损坏或身份不匹配，已保留原文件并按双方当前内容重建，已删除文件可能重新出现。');
    }
    else if (read.status === 'absent') {
      const oldLocations = [ctx.stateUri, ctx.legacyStateUri];
      for (const location of oldLocations) {
        try {
          await vscode.workspace.fs.stat(manifestUri(location, cfg.webdav.url, remoteRoot));
          manifest.rebuilding = true;
          warnings.push('旧同步基线缺少目录与账号归属，已保留旧文件并重建基线，已删除文件可能重新出现。');
          break;
        }
        catch (error) {
          if (!isMissing(error)) {
            throw error;
          }
        }
      }
    }
    const previous = {
      ...manifest.files
    };
    const actions = planSync(previous, local, remote).map(action => action.type === 'record' && manifest.pending?.[action.path]
      ? {
        type: 'compare' as const, path: action.path
      } : action);
    const planned = new Set(actions.map(action => action.path));
    for (const relative of Object.keys(manifest.pending ?? {})) {
      if (!planned.has(relative)) {
        actions.push({
          type: 'forget', path: relative
        });
      }
    }
    let batchSize = 0;
    let conflictCount = 0;
    let pendingCount = 0;
    const snapshot = () => JSON.stringify([manifest.files, manifest.pending, manifest.rebuilding]);
    let committedState = snapshot();
    const commit = async (current: ActionExecutor) => {
      manifest.files = current.buildManifestFiles(previous);
      manifest.pending = {
        ...manifest.pending, ...current.pending
      };
      for (const relative of current.completed) {
        delete manifest.pending[relative];
      }
      const next = snapshot();
      if (next === committedState) { return; }
      ctx.assertActive?.();
      await writeManifest(uri, manifest);
      committedState = next;
      batchSize = 0;
      conflictCount = current.result.conflicts.length;
      pendingCount = current.result.pending.length;
    };
    const executor = new ActionExecutor(client, ctx, remoteRoot, local, remote, previous, async (current, action) => {
      ctx.assertActive?.();
      const critical = ['deleteLocal', 'deleteRemote'].includes(action.type) ||
        current.result.conflicts.length > conflictCount || current.result.pending.length > pendingCount;
      if (action.type !== 'record' && action.type !== 'forget') {
        batchSize++;
      }
      if (!critical && batchSize < 10) {
        return false;
      }
      await commit(current);
      return true;
    });
    assertSyncActive(ctx);
    let failed = false;
    let runError: unknown;
    try {
      await executor.run(actions);
      if (manifest.rebuilding && executor.result.outcome === 'complete') { manifest.rebuilding = false; }
    }
    catch (error) {
      failed = true;
      runError = error;
    }
    try {
      await commit(executor);
      await executor.finalizeCheckpoint();
    } catch (error) {
      if (!failed) { throw error; }
      log.error('保存同步检查点失败，已保留原始同步错误。', error);
    }
    if (failed) { throw runError; }
    executor.result.warnings.push(...warnings);
    return executor.result;
  }
}
