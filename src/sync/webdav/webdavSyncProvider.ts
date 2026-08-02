import * as path from 'path';
// webdav v5 是纯 ESM 包，用动态 import 引入，扩展本身仍以 CommonJS 打包
import type { FileStat, WebDAVClient } from 'webdav' with { 'resolution-mode': 'import' };
import * as vscode from 'vscode';
import { getSyncConfig } from '../../config';
import { log } from '../../log';
import { resolveConflictUri } from '../conflict';
import { getSecretFor } from '../secrets';
import {
  emptyResult,
  SyncConfigError,
  type SyncContext,
  type SyncProvider,
  type SyncResult,
} from '../syncProvider';
import { planSync, type RemoteFile, type SyncAction } from './diff';
import {
  manifestUri,
  migrateLegacyManifest,
  quarantineManifest,
  readManifest,
  writeManifest,
  type Manifest,
  type ManifestEntry,
} from './manifest';
import { hashContent, scanLocal, type LocalFile } from './scanner';

export class WebdavSyncProvider implements SyncProvider {
  readonly id = 'webdav' as const;
  readonly displayName = 'WebDAV';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async validate(): Promise<void> {
    const cfg = getSyncConfig();
    if (!cfg.webdav.url) {
      throw new SyncConfigError('未配置 WebDAV 服务地址。');
    }
    if (!cfg.webdav.username) {
      throw new SyncConfigError('未配置 WebDAV 用户名。');
    }
    if (!(await getSecretFor(this.context, 'webdav'))) {
      throw new SyncConfigError('未设置 WebDAV 密码，请在设置页的 WebDAV 一节中录入。');
    }
  }

  /** 用一次 PROPFIND 验证地址、账号与密码是否可用 */
  async testConnection(): Promise<string> {
    await this.validate();
    const cfg = getSyncConfig();
    const remoteRoot = normalizeRemotePath(cfg.webdav.remotePath);
    const client = await this.createClient();

    try {
      const exists = await client.exists(remoteRoot);
      return exists
        ? `连接成功，远端目录「${remoteRoot}」已存在。`
        : `连接成功，但远端尚无目录「${remoteRoot}」，首次同步时会自动创建。`;
    } catch (err) {
      throw new SyncConfigError(`无法连接 WebDAV 服务：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async createClient(): Promise<WebDAVClient> {
    const cfg = getSyncConfig();
    const password = (await getSecretFor(this.context, 'webdav')) ?? '';
    const { createClient } = await import('webdav');
    return createClient(cfg.webdav.url, { username: cfg.webdav.username, password });
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const cfg = getSyncConfig();
    const remoteRoot = normalizeRemotePath(cfg.webdav.remotePath);
    const client = await this.createClient();

    ctx.report('检查远端目录');
    if (!(await client.exists(remoteRoot))) {
      await client.createDirectory(remoteRoot, { recursive: true });
      log.info(`已在远端创建目录 ${remoteRoot}`);
    }

    ctx.report('扫描本地笔记');
    const local = await scanLocal(ctx.root);

    ctx.report('读取远端列表');
    const remote = await listRemote(client, remoteRoot);

    const uri = manifestUri(ctx.stateUri, cfg.webdav.url, remoteRoot);
    const { manifest, warning } = await this.loadManifest(uri, ctx, cfg.webdav.url, remoteRoot);

    const actions = planSync(manifest.files, local, remote);
    log.info(`本地 ${local.size} 个文件，远端 ${remote.size} 个文件，待处理 ${actions.length} 项`);

    const executor = new ActionExecutor(client, ctx, remoteRoot, local, remote);
    await executor.run(actions);

    ctx.report('更新同步状态');
    manifest.files = executor.buildManifestFiles(manifest.files);
    await writeManifest(uri, manifest);

    if (warning) {
      executor.result.warnings.push(warning);
    }
    return executor.result;
  }

  /** 读取基线，必要时从旧的 Profile 私有目录迁移；基线损坏时给出面向用户的说明 */
  private async loadManifest(
    uri: vscode.Uri,
    ctx: SyncContext,
    url: string,
    remoteRoot: string,
  ): Promise<{ manifest: Manifest; warning?: string }> {
    let read = await readManifest(uri);

    if (read.status === 'absent') {
      const legacy = manifestUri(ctx.legacyStateUri, url, remoteRoot);
      if (await migrateLegacyManifest(uri, legacy)) {
        read = await readManifest(uri);
      }
    }

    if (read.status === 'corrupted') {
      await quarantineManifest(uri);
      return {
        manifest: read.manifest,
        warning:
          '同步基线已损坏，本轮按首次同步处理：此前在本机删除、而远端仍保留的笔记会被重新下载回来，' +
          '请确认笔记目录中是否出现了已删除的内容。',
      };
    }

    return { manifest: read.manifest };
  }
}

/** 按顺序执行同步动作，单个文件失败只记录不中断（导出仅供 verify 脚本注入假客户端） */
export class ActionExecutor {
  readonly result: SyncResult = emptyResult();
  /** 本轮结束后本地各文件的最终指纹，用于回写清单 */
  private readonly finalLocal: Map<string, LocalFile>;
  /** 本轮已确认同步到位的路径及其新基线 */
  private readonly baseline = new Map<string, ManifestEntry>();
  private readonly ensuredDirs = new Set<string>();

  constructor(
    private readonly client: WebDAVClient,
    private readonly ctx: SyncContext,
    private readonly remoteRoot: string,
    local: Map<string, LocalFile>,
    /** 同步开始时的远端状态，未经传输的文件直接沿用其中的 ETag */
    private readonly remote: Map<string, RemoteFile>,
  ) {
    this.finalLocal = new Map(local);
  }

  async run(actions: SyncAction[]): Promise<void> {
    let done = 0;
    for (const action of actions) {
      if (this.ctx.token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      done++;
      if (action.type !== 'record' && action.type !== 'forget') {
        this.ctx.report(`处理 ${action.path}（${done}/${actions.length}）`);
      }
      try {
        await this.execute(action);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn(`处理 ${action.path} 失败：${reason}`);
        this.result.failures.push({ relativePath: action.path, reason });
      }
    }
  }

  private async execute(action: SyncAction): Promise<void> {
    switch (action.type) {
      case 'upload':
        await this.upload(action.path);
        this.result.uploaded.push(action.path);
        break;

      case 'download':
        if (await this.download(action.path)) {
          this.result.downloaded.push(action.path);
        }
        break;

      case 'deleteLocal':
        await vscode.workspace.fs.delete(this.localUri(action.path), { useTrash: true });
        this.finalLocal.delete(action.path);
        this.result.deletedLocal.push(action.path);
        break;

      case 'deleteRemote':
        await this.client.deleteFile(this.remotePath(action.path));
        this.result.deletedRemote.push(action.path);
        break;

      case 'compare':
        await this.compare(action.path);
        break;

      case 'resurrectLocal':
        // 远端已删但本地有修改：重新上传，并告知用户远端的删除被覆盖了
        await this.upload(action.path);
        this.result.uploaded.push(action.path);
        this.result.conflicts.push({
          relativePath: action.path,
          copyUri: this.localUri(action.path),
          description: '远端已删除但本地有修改，已保留并重新上传本地版本',
        });
        break;

      case 'resurrectRemote':
        // 本地已删但远端有修改：恢复远端内容，避免丢掉对方的改动
        if (await this.download(action.path)) {
          this.result.downloaded.push(action.path);
          this.result.conflicts.push({
            relativePath: action.path,
            copyUri: this.localUri(action.path),
            description: '本地已删除但远端有修改，已恢复远端版本',
          });
        }
        break;

      case 'record': {
        // 双方一致，无需传输：基线沿用同步开始时列出的远端状态
        const localEntry = this.finalLocal.get(action.path);
        if (localEntry) {
          this.settle(action.path, localEntry, this.remote.get(action.path));
        }
        break;
      }

      case 'forget':
        this.finalLocal.delete(action.path);
        break;
    }
  }

  /** 双方都存在且都可能变化，只能取回远端内容逐字节比对 */
  private async compare(relativePath: string): Promise<void> {
    const remoteContent = await this.readRemote(relativePath);
    const localEntry = this.finalLocal.get(relativePath);
    const remoteHash = hashContent(remoteContent);

    if (localEntry && localEntry.hash === remoteHash) {
      this.settle(relativePath, localEntry, this.remote.get(relativePath));
      return;
    }

    // 内容确有分歧：本地版本原地保留，远端版本另存为副本并立即上传，
    // 这样另一台设备下次同步也能看到这次冲突
    const copyUri = await resolveConflictUri(this.ctx.root, relativePath, this.ctx.deviceName);
    await vscode.workspace.fs.writeFile(copyUri, remoteContent);

    const copyRelative = toRelative(this.ctx.root, copyUri);
    this.finalLocal.set(copyRelative, { size: remoteContent.byteLength, hash: remoteHash });
    await this.upload(copyRelative);
    this.result.uploaded.push(copyRelative);

    await this.upload(relativePath);
    this.result.uploaded.push(relativePath);

    this.result.conflicts.push({
      relativePath,
      copyUri,
      description: '本地与远端都有修改，已保留本地版本，远端版本另存为副本',
    });
  }

  private async upload(relativePath: string): Promise<void> {
    const content = await vscode.workspace.fs.readFile(this.localUri(relativePath));
    const target = this.remotePath(relativePath);
    await this.ensureRemoteDir(path.posix.dirname(target));
    await this.client.putFileContents(target, Buffer.from(content), { overwrite: true });

    const localEntry: LocalFile = { size: content.byteLength, hash: hashContent(content) };
    this.finalLocal.set(relativePath, localEntry);
    // 上传改变了远端 ETag，必须重新取一次，不能沿用同步开始时列出的旧值
    this.settle(relativePath, localEntry, await this.statRemote(target));
  }

  /** 返回是否真的落盘；内容被改存为冲突副本时返回 false */
  private async download(relativePath: string): Promise<boolean> {
    const content = await this.readRemote(relativePath);
    const target = this.localUri(relativePath);

    if (isDirtyInEditor(target)) {
      // 另一个窗口可能正在编辑这个文件且尚未保存。直接覆盖的话，那份未保存的
      // 修改会在用户保存时反过来盖掉远端内容，而且下轮只会被当成普通的本地修改
      // 上传，对方的改动就此丢失。改为另存副本，两边内容都保住。
      const copyUri = await resolveConflictUri(this.ctx.root, relativePath, this.ctx.deviceName);
      await vscode.workspace.fs.writeFile(copyUri, content);
      this.result.conflicts.push({
        relativePath,
        copyUri,
        description: '该笔记在编辑器中有未保存的修改，远端版本已另存为副本，未覆盖正在编辑的内容',
      });
      return false;
    }

    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
    await vscode.workspace.fs.writeFile(target, content);

    const localEntry: LocalFile = { size: content.byteLength, hash: hashContent(content) };
    this.finalLocal.set(relativePath, localEntry);
    // 内容取自同步开始时列出的那个版本，基线就该记那一版的 ETag
    this.settle(relativePath, localEntry, this.remote.get(relativePath));
    return true;
  }

  private settle(relativePath: string, local: LocalFile, remote: RemoteFile | undefined): void {
    this.baseline.set(relativePath, {
      size: local.size,
      hash: local.hash,
      remoteEtag: remote?.etag,
      remoteLastmod: remote?.lastmod,
    });
  }

  private async readRemote(relativePath: string): Promise<Uint8Array> {
    const data = await this.client.getFileContents(this.remotePath(relativePath), { format: 'binary' });
    // Node 环境下返回 Buffer，浏览器实现返回 ArrayBuffer，两种都要能转成字节视图
    if (Buffer.isBuffer(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return new Uint8Array(data as ArrayBuffer);
  }

  /** 取回单个文件的最新远端状态；失败只是让基线少一项校验依据，不影响本次传输 */
  private async statRemote(remotePath: string): Promise<RemoteFile | undefined> {
    try {
      const stat = (await this.client.stat(remotePath)) as FileStat;
      return { size: stat.size, etag: stat.etag ?? undefined, lastmod: stat.lastmod };
    } catch (err) {
      log.warn(`读取 ${remotePath} 的远端状态失败：${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private async ensureRemoteDir(dir: string): Promise<void> {
    if (dir === this.remoteRoot || dir === '/' || this.ensuredDirs.has(dir)) {
      return;
    }
    if (!(await this.client.exists(dir))) {
      await this.client.createDirectory(dir, { recursive: true });
    }
    this.ensuredDirs.add(dir);
  }

  /**
   * 用本轮各动作当场记下的状态重建清单基线。
   *
   * 不能在同步结束后重新列一次远端来取 ETag：从判定「双方一致」到那次列表之间，
   * 另一台设备可能已经改过远端，那样基线就会把「本地旧内容」和「远端新 ETag」
   * 配成一对，下轮两侧都判定为未变化，对方的改动会被永久忽略。
   */
  buildManifestFiles(previous: Record<string, ManifestEntry>): Record<string, ManifestEntry> {
    const files: Record<string, ManifestEntry> = {};

    for (const relativePath of this.finalLocal.keys()) {
      const settled = this.baseline.get(relativePath);
      if (settled) {
        files[relativePath] = settled;
      } else if (previous[relativePath]) {
        // 本轮未成功处理：沿用旧基线，使下轮仍能识别出差异
        files[relativePath] = previous[relativePath];
      }
    }

    return files;
  }

  private localUri(relativePath: string): vscode.Uri {
    return vscode.Uri.joinPath(this.ctx.root, ...relativePath.split('/'));
  }

  private remotePath(relativePath: string): string {
    return path.posix.join(this.remoteRoot, relativePath);
  }
}

/** 归一化远端路径：确保以 / 开头、不以 / 结尾（根目录除外） */
export function normalizeRemotePath(input: string): string {
  const withLeading = input.startsWith('/') ? input : `/${input}`;
  const trimmed = withLeading.replace(/\/+$/, '');
  return trimmed || '/';
}

/** 该文件是否在本窗口的编辑器中有未保存的修改 */
function isDirtyInEditor(uri: vscode.Uri): boolean {
  return vscode.workspace.textDocuments.some((doc) => doc.isDirty && doc.uri.fsPath === uri.fsPath);
}

async function listRemote(client: WebDAVClient, remoteRoot: string): Promise<Map<string, RemoteFile>> {
  const contents = (await client.getDirectoryContents(remoteRoot, { deep: true })) as FileStat[];
  const files = new Map<string, RemoteFile>();

  for (const stat of contents) {
    if (stat.type !== 'file') {
      continue;
    }
    const relativePath = stripPrefix(stat.filename, remoteRoot);
    if (!relativePath) {
      continue;
    }
    files.set(relativePath, {
      size: stat.size,
      etag: stat.etag ?? undefined,
      lastmod: stat.lastmod,
    });
  }

  return files;
}

function stripPrefix(filename: string, remoteRoot: string): string {
  const normalized = filename.startsWith('/') ? filename : `/${filename}`;
  const prefix = remoteRoot === '/' ? '/' : `${remoteRoot}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : '';
}

function toRelative(root: vscode.Uri, uri: vscode.Uri): string {
  return path.relative(root.fsPath, uri.fsPath).split(path.sep).join('/');
}
