import * as path from 'path';
import type { WebDAVClient } from 'webdav' with { 'resolution-mode': 'import' };
import { LocalChangedError, LocalFileStore } from '../localFileStore';
import { assertSyncActive, emptyResult, finishResult, type SyncContext } from '../syncProvider';
import { planSync, type RemoteFile, type SyncAction } from './diff';
import type { ManifestEntry, PendingAction } from './manifest';
import { hashContent, type LocalFile } from './scanner';
import { RemoteChangedError, UncertainWriteError, WebdavTransport, requestSignal, type RemoteContent } from './webdavTransport';
/** 动作结果逐项确认，失败和取消后保留原基线及未确认操作。 */
export class ActionExecutor {
  readonly result = emptyResult();
  readonly pending: Record<string, PendingAction> = Object.create(null);
  readonly completed = new Set<string>();
  private readonly settled = new Map<string, ManifestEntry>();
  private readonly removed = new Set<string>();
  private readonly localStore: LocalFileStore;
  private readonly transport: WebdavTransport;
  private readonly ensuredDirs = new Set<string>();
  constructor(private readonly client: WebDAVClient, private readonly context: SyncContext, private readonly remoteRoot: string, private readonly local: Map<string, LocalFile>, private readonly remote: Map<string, RemoteFile>, private readonly previous: Record<string, ManifestEntry> = {}, private readonly checkpoint?: (executor: ActionExecutor, action: SyncAction) => Promise<boolean>) {
    this.localStore = new LocalFileStore(context);
    this.transport = new WebdavTransport(client, context);
  }
  async run(actions: SyncAction[]): Promise<void> {
    for (const [index, original] of actions.entries()) {
      assertSyncActive(this.context);
      let action = original;
      this.context.report(`处理 ${action.path}（${index + 1}/${actions.length}）`);
      for (let attempt = 0;;attempt++) {
        try {
          await this.execute(action);
          delete this.pending[action.path];
          this.completed.add(action.path);
          break;
        }
        catch (error) {
          let failure = error;
          if (error instanceof RemoteChangedError && attempt === 0) {
            try {
              action = await this.replan(action.path);
              continue;
            }
            catch (refreshError) {
              failure = refreshError;
            }
          }
          const reason = failure instanceof Error ? failure.message : String(failure);
          if (failure instanceof LocalChangedError || failure instanceof RemoteChangedError) {
            this.result.deferred.push({
              relativePath: action.path, reason
            });
          }
          else if (failure instanceof UncertainWriteError) {
            this.pending[action.path] = {
              action: action.type, reason
            };
            this.result.pending.push({
              relativePath: action.path, reason
            });
          }
          else {
            this.result.failures.push({
              relativePath: action.path, reason
            });
          }
          break;
        }
      }
      // 即使用户取消，也先提交本项已经确认的结果；租约失效由提交方拒绝。
      const committed = await this.checkpoint?.(this, action);
      if (committed) {
        await this.localStore.finalize();
      }
      assertSyncActive(this.context);
    }
    if (this.transport.compatibility) {
      this.result.warnings.push('WebDAV 当前使用兼容模式，通过内容复查检测变化，服务端缺少强版本条件保护。');
    }
    finishResult(this.result);
  }
  private async execute(action: SyncAction): Promise<void> {
    const relative = action.path;
    await this.localStore.uri(relative);
    assertSyncActive(this.context);
    switch (action.type) {
      case 'record': {
        await this.localStore.check(relative, this.local.get(relative));
        const local = this.local.get(relative);
        if (local) {
          this.settle(relative, local, this.remote.get(relative));
        }
        return;
      }
      case 'forget':
        await this.localStore.check(relative, undefined);
        this.removed.add(relative);
        return;
      case 'upload':
      case 'resurrectLocal':
        await this.upload(relative);
        if (action.type === 'resurrectLocal') {
          this.result.conflicts.push({
            relativePath: relative, copyUri: await this.localStore.uri(relative), description: '远端已删除，本地修改已保留并重新上传。'
          });
        }
        return;
      case 'download':
      case 'resurrectRemote':
        await this.download(relative, action.type === 'resurrectRemote');
        return;
      case 'compare':
        await this.compare(relative);
        return;
      case 'deleteLocal':
        await this.localStore.delete(relative, this.local.get(relative));
        this.removed.add(relative);
        this.result.deletedLocal.push(relative);
        return;
      case 'deleteRemote':
        await this.localStore.check(relative, undefined);
        await this.transport.delete(this.remotePath(relative), this.expectedRemote(relative));
        this.removed.add(relative);
        this.result.deletedRemote.push(relative);
        return;
    }
  }
  private expectedRemote(relative: string): RemoteFile | undefined {
    const remote = this.remote.get(relative);
    return remote ? {
      ...remote, hash: remote.hash ?? this.previous[relative]?.hash
    } : undefined;
  }
  private async upload(relative: string): Promise<void> {
    await this.localStore.check(relative, this.local.get(relative));
    const content = await this.localStore.read(relative);
    if (!content) {
      throw new LocalChangedError('本地文件已删除。');
    }
    const target = this.remotePath(relative);
    await this.ensureRemoteDir(path.posix.dirname(target));
    assertSyncActive(this.context);
    const remote = await this.transport.write(target, content, this.expectedRemote(relative));
    this.settle(relative, {
      hash: hashContent(content), size: content.byteLength
    }, remote);
    this.remote.set(relative, remote);
    this.result.uploaded.push(relative);
  }
  private async download(relative: string, resurrect: boolean): Promise<void> {
    const remote = await this.transport.read(this.remotePath(relative), this.remote.get(relative));
    await this.applyDownload(relative, remote, resurrect);
  }
  private async applyDownload(relative: string, remote: RemoteContent, resurrect: boolean): Promise<void> {
    try {
      await this.localStore.write(relative, remote.content, this.local.get(relative));
    }
    catch (error) {
      if (!(error instanceof LocalChangedError)) {
        throw error;
      }
      const copyUri = await this.localStore.conflict(relative, remote.content);
      this.result.conflicts.push({
        relativePath: relative, copyUri, description: '本地笔记发生变化，远端内容已另存为冲突副本。'
      });
      throw error;
    }
    this.settle(relative, {
      hash: hashContent(remote.content), size: remote.content.byteLength
    }, remote.file);
    this.result.downloaded.push(relative);
    if (resurrect) {
      this.result.conflicts.push({
        relativePath: relative, copyUri: await this.localStore.uri(relative), description: '本地已删除，远端修改已恢复。'
      });
    }
  }
  private async compare(relative: string): Promise<void> {
    await this.localStore.check(relative, this.local.get(relative));
    const remote = await this.transport.read(this.remotePath(relative));
    this.remote.set(relative, remote.file);
    const local = this.local.get(relative);
    if (local && local.hash === remote.file.hash) {
      this.settle(relative, local, remote.file);
      return;
    }
    if (local && this.previous[relative]?.hash === local.hash) {
      await this.applyDownload(relative, remote, false);
      return;
    }
    const copyUri = await this.localStore.conflict(relative, remote.content);
    this.result.conflicts.push({
      relativePath: relative, copyUri, description: '双方内容不同，本地内容保留，远端内容已另存为冲突副本。'
    });
    const copyRelative = path.relative(this.context.root.fsPath, copyUri.fsPath).split(path.sep).join('/');
    this.local.set(copyRelative, {
      size: remote.content.byteLength, hash: hashContent(remote.content)
    });
    await this.upload(copyRelative);
    await this.upload(relative);
  }
  private settle(relative: string, local: LocalFile, remote?: RemoteFile): void {
    this.settled.set(relative, {
      size: local.size, hash: local.hash, remoteEtag: remote?.etag, remoteLastmod: remote?.lastmod
    });
  }
  private async replan(relative: string): Promise<SyncAction> {
    if (await this.client.exists(this.remotePath(relative), { signal: requestSignal(this.context) })) {
      const current = await this.transport.read(this.remotePath(relative));
      this.remote.set(relative, current.file);
    }
    else {
      this.remote.delete(relative);
    }
    const previous = this.previous[relative] ? {
      [relative]: this.previous[relative]
    } : {};
    const local = new Map(this.local.has(relative) ? [[relative, this.local.get(relative)!]] : []);
    const remote = new Map(this.remote.has(relative) ? [[relative, this.remote.get(relative)!]] : []);
    return planSync(previous, local, remote)[0] ?? {
      type: 'forget', path: relative
    };
  }
  buildManifestFiles(previous: Record<string, ManifestEntry>): Record<string, ManifestEntry> {
    const files = Object.assign(Object.create(null), previous) as Record<string, ManifestEntry>;
    for (const relative of this.removed) {
      delete files[relative];
    }
    for (const [relative, entry] of this.settled) {
      files[relative] = entry;
    }
    return files;
  }
  async finalizeCheckpoint(): Promise<void> {
    await this.localStore.finalize();
  }
  private remotePath(relative: string): string {
    return path.posix.join(this.remoteRoot, relative);
  }
  private async ensureRemoteDir(directory: string): Promise<void> {
    if (directory === this.remoteRoot || directory === '/' || this.ensuredDirs.has(directory)) {
      return;
    }
    assertSyncActive(this.context);
    if (!(await this.client.exists(directory, { signal: requestSignal(this.context) }))) {
      await this.client.createDirectory(directory, {
        recursive: true, signal: requestSignal(this.context)
      });
    }
    this.ensuredDirs.add(directory);
  }
}
