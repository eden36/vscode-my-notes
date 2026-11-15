import * as path from 'path';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { updateConfig } from '../config';
import { log } from '../log';
import { isInside } from '../sync/syncPath';
import type { SyncManager } from '../sync/syncManager';
import {
  allocateUniqueName,
  dedupeSelection,
  isNestedCopyDestination,
  isSelfOrDescendant,
  resolveDropDirectory,
} from './noteDragHelpers';
import { exists } from './noteFs';
import { NoteItem } from './noteItem';
import type { NotesTreeProvider } from './notesTreeProvider';

const TREE_MIME = 'application/vnd.code.tree.syncnotes.notesView';
const FS_CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

type ConflictAction = 'skip' | 'rename' | 'overwrite';

interface DropSource {
  uri: vscode.Uri;
  name: string;
}

interface DropBatchResult {
  successUris: vscode.Uri[];
  messages: string[];
  /** 失败项未能清理干净等情形，即使无成功项也应触发同步 */
  needsSync: boolean;
}

/** 笔记树拖放：树内移动、外部复制；撞名与同步策略见产品共识。 */
export class NotesDragDropController implements vscode.TreeDragAndDropController<NoteItem> {
  readonly dragMimeTypes = [TREE_MIME];
  readonly dropMimeTypes = [TREE_MIME, 'text/uri-list', 'Files'];

  constructor(
    private readonly provider: NotesTreeProvider,
    private readonly getTreeView: () => vscode.TreeView<NoteItem>,
    private readonly syncManager: SyncManager,
  ) {}

  handleDrag(source: readonly NoteItem[], dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): void {
    dataTransfer.set(TREE_MIME, new vscode.DataTransferItem(source.map((item) => item.uri.toString())));
    dataTransfer.set(
      'text/uri-list',
      new vscode.DataTransferItem(source.map((item) => item.uri.toString()).join('\r\n')),
    );
  }

  async handleDrop(
    target: NoteItem | undefined,
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const root = this.provider.rootUri;
    if (!root) {
      void vscode.window.showWarningMessage('尚未设置笔记目录。');
      return;
    }

    const destDirPath = resolveDropDirectory(
      root.fsPath,
      target?.uri.fsPath,
      target?.kind,
    );
    if (!destDirPath) {
      void vscode.window.showWarningMessage('无法移动到该位置。');
      return;
    }
    const destDir = vscode.Uri.file(destDirPath);

    const treeItem = dataTransfer.get(TREE_MIME);
    const isInternal = treeItem !== undefined;
    let sources: DropSource[];
    try {
      sources = isInternal
        ? await this.parseInternalSources(treeItem, root)
        : await this.parseExternalSources(dataTransfer);
    } catch (err) {
      log.error('解析拖放来源失败', err);
      void vscode.window.showErrorMessage('无法解析拖放内容。');
      return;
    }

    if (sources.length === 0 || token.isCancellationRequested) {
      return;
    }

    if (isInternal) {
      const validated = this.filterInternalMoves(sources, destDirPath, root.fsPath);
      if (validated.rejectedReason) {
        void vscode.window.showWarningMessage(validated.rejectedReason);
      }
      sources = validated.sources;
      if (sources.length === 0) {
        return;
      }
      if (!(await this.confirmMove(sources, destDir))) {
        return;
      }
    } else {
      const validated = this.filterExternalImports(sources, destDirPath);
      if (validated.rejectedReason) {
        void vscode.window.showWarningMessage(validated.rejectedReason);
      }
      sources = validated.sources;
      if (sources.length === 0) {
        return;
      }
    }

    if (token.isCancellationRequested) {
      return;
    }

    // 独占写盘期间阻止新同步；requestSync 须在回调外触发以免死锁
    let result: DropBatchResult;
    try {
      result = await this.syncManager.runExclusiveLocalWrite(root, async (assertActive) => {
        if (token.isCancellationRequested) {
          return { successUris: [] as vscode.Uri[], messages: [] as string[], needsSync: false };
        }
        return isInternal
          ? await this.runMoves(sources, destDir, token, assertActive)
          : await this.runImports(sources, destDir, token, assertActive);
      });
    } catch (err) {
      log.error('拖放失败', err);
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      return;
    }

    this.provider.refresh();
    if (result.successUris.length === 1) {
      try {
        await this.getTreeView().reveal(new NoteItem(result.successUris[0], await this.kindOf(result.successUris[0])), {
          select: true,
          focus: true,
        });
      } catch (err) {
        log.error('定位拖放结果失败', err);
      }
    }

    if (result.messages.length > 0) {
      void vscode.window.showInformationMessage(result.messages.join('；'));
    }
    if (result.successUris.length > 0 || result.needsSync) {
      void this.syncManager.requestSync('manual');
    }
  }

  private async parseInternalSources(
    item: vscode.DataTransferItem,
    root: vscode.Uri,
  ): Promise<DropSource[]> {
    const raw = item.value;
    const uris: vscode.Uri[] = Array.isArray(raw)
      ? raw.map((entry) => typeof entry === 'string' ? vscode.Uri.parse(entry) : (entry as NoteItem).uri)
      : [];
    const paths = dedupeSelection(
      uris.map((uri) => uri.fsPath).filter((fsPath) => isInside(root.fsPath, fsPath)),
    );
    return paths.map((fsPath) => ({
      uri: vscode.Uri.file(fsPath),
      name: path.basename(fsPath),
    }));
  }

  private async parseExternalSources(dataTransfer: vscode.DataTransfer): Promise<DropSource[]> {
    const seen = new Set<string>();
    const sources: DropSource[] = [];
    const add = (uri: vscode.Uri) => {
      const key = path.normalize(uri.fsPath);
      if (seen.has(key) || uri.scheme !== 'file') {
        return;
      }
      seen.add(key);
      sources.push({ uri, name: path.basename(uri.fsPath) });
    };

    const uriList = await dataTransfer.get('text/uri-list')?.asString();
    if (uriList) {
      for (const line of uriList.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }
        try {
          add(vscode.Uri.parse(trimmed));
        } catch {
          // 忽略非法 URI
        }
      }
    }

    for (const [mime, transferItem] of toEntries(dataTransfer)) {
      if (mime.toLowerCase() !== 'files') {
        continue;
      }
      const file = transferItem.asFile();
      if (file?.uri) {
        add(file.uri);
      }
    }

    return sources;
  }

  private filterInternalMoves(
    sources: DropSource[],
    destDirPath: string,
    rootPath: string,
  ): { sources: DropSource[]; rejectedReason?: string } {
    const kept: DropSource[] = [];
    let rejectedReason: string | undefined;
    for (const source of sources) {
      if (!isInside(rootPath, source.uri.fsPath)) {
        rejectedReason = '只能移动笔记目录内的项目。';
        continue;
      }
      if (isSelfOrDescendant(source.uri.fsPath, destDirPath)) {
        rejectedReason = '无法移动到自身或子目录。';
        continue;
      }
      if (path.normalize(path.dirname(source.uri.fsPath)) === path.normalize(destDirPath)) {
        continue;
      }
      kept.push(source);
    }
    return { sources: kept, rejectedReason };
  }

  /** 拒绝把目录复制到其自身或子路径下，避免递归复制失控。 */
  private filterExternalImports(
    sources: DropSource[],
    destDirPath: string,
  ): { sources: DropSource[]; rejectedReason?: string } {
    const kept: DropSource[] = [];
    let rejectedReason: string | undefined;
    for (const source of sources) {
      if (isNestedCopyDestination(source.uri.fsPath, destDirPath)) {
        rejectedReason = '无法复制到源目录自身或子目录。';
        continue;
      }
      kept.push(source);
    }
    return { sources: kept, rejectedReason };
  }

  private async confirmMove(sources: DropSource[], destDir: vscode.Uri): Promise<boolean> {
    if (!this.provider.notesConfig.confirmDragAndDrop) {
      return true;
    }
    const destLabel = destDir.fsPath === this.provider.rootUri?.fsPath
      ? '笔记根目录'
      : path.basename(destDir.fsPath);
    const message = sources.length > 1
      ? `确定将 ${sources.length} 项移动到「${destLabel}」？`
      : `确定将「${sources[0].name}」移动到「${destLabel}」？`;
    const choice = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      '移动',
      '移动且不再询问',
    );
    if (choice === '移动且不再询问') {
      await updateConfig('confirmDragAndDrop', false);
      return true;
    }
    return choice === '移动';
  }

  private async runMoves(
    sources: DropSource[],
    destDir: vscode.Uri,
    token: vscode.CancellationToken,
    assertActive: () => void,
  ): Promise<DropBatchResult> {
    return this.runBatch(sources, destDir, token, 'move', async (source, target, overwrite) => {
      await vscode.workspace.fs.rename(source.uri, target, { overwrite });
    }, assertActive);
  }

  private async runImports(
    sources: DropSource[],
    destDir: vscode.Uri,
    token: vscode.CancellationToken,
    assertActive: () => void,
  ): Promise<DropBatchResult> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '正在导入到笔记目录',
        cancellable: true,
      },
      async (progress, progressToken) => {
        const linked = linkTokens(token, progressToken);
        return this.runBatch(sources, destDir, linked, 'import', async (source, target, overwrite) => {
          progress.report({ message: source.name });
          await copyRecursive(source.uri, target, overwrite, linked, assertActive);
        }, assertActive);
      },
    );
  }

  private async runBatch(
    sources: DropSource[],
    destDir: vscode.Uri,
    token: vscode.CancellationToken,
    mode: 'move' | 'import',
    write: (source: DropSource, target: vscode.Uri, overwrite: boolean) => Promise<void>,
    assertActive: () => void,
  ): Promise<DropBatchResult> {
    const taken = await listNames(destDir);
    const successUris: vscode.Uri[] = [];
    let skipped = 0;
    let failed = 0;
    let needsSync = false;
    let applyAll: ConflictAction | undefined;

    for (const source of sources) {
      if (token.isCancellationRequested) {
        break;
      }
      let name = source.name;
      if (validateDropName(name)) {
        failed += 1;
        continue;
      }

      let overwrite = false;
      if (samePath(source.uri, joinName(destDir, name))) {
        skipped += 1;
        continue;
      }
      const conflictUri = findTakenUri(destDir, name, taken);
      if (conflictUri && !samePath(source.uri, conflictUri)) {
        const targetIsDirectory = await isDir(conflictUri);
        const resolved = await this.resolveConflict(name, targetIsDirectory, applyAll);
        if (resolved === undefined) {
          break;
        }
        if (resolved.applyAll) {
          applyAll = resolved.action;
        }
        if (resolved.action === 'skip') {
          skipped += 1;
          continue;
        }
        if (resolved.action === 'rename' || (resolved.action === 'overwrite' && targetIsDirectory)) {
          name = allocateUniqueName(name, taken, FS_CASE_INSENSITIVE);
        } else {
          overwrite = true;
        }
      }

      const finalTarget = joinName(destDir, name);
      let staging: vscode.Uri | undefined;
      try {
        assertActive();
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
        if (mode === 'import') {
          // 排他创建临时目录，失败时只清理本次拥有的内容。
          staging = vscode.Uri.file(await fs.mkdtemp(path.join(destDir.fsPath, '.syncnotes-import-')));
          const stagedTarget = joinName(staging, name);
          await write(source, stagedTarget, false);
          assertActive();
          if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
          await vscode.workspace.fs.rename(stagedTarget, finalTarget, { overwrite });
        } else {
          await write(source, finalTarget, overwrite);
        }
        taken.add(name);
        successUris.push(finalTarget);
      } catch (err) {
        failed += 1;
        log.error(`${mode === 'move' ? '移动' : '导入'}失败：${source.uri.fsPath}`, err);
      } finally {
        if (staging) {
          const cleaned = await cleanupPartialImport(staging, assertActive);
          if (!cleaned) {
            needsSync = true;
          }
        }
      }
    }

    const messages: string[] = [];
    if (successUris.length > 0) {
      messages.push(mode === 'move'
        ? `已移动 ${successUris.length} 项`
        : `已导入 ${successUris.length} 项`);
    }
    if (skipped > 0) {
      messages.push(`跳过 ${skipped} 项`);
    }
    if (failed > 0) {
      messages.push(`失败 ${failed} 项`);
    }
    if (token.isCancellationRequested && mode === 'import') {
      messages.push('导入已取消');
    }
    return { successUris, messages, needsSync };
  }

  private async resolveConflict(
    name: string,
    isDirectory: boolean,
    applyAll: ConflictAction | undefined,
  ): Promise<{ action: ConflictAction; applyAll: boolean } | undefined> {
    if (applyAll) {
      const action = applyAll === 'overwrite' && isDirectory ? 'rename' : applyAll;
      return { action, applyAll: false };
    }

    const buttons = isDirectory
      ? ['跳过', '自动改名', '全部跳过', '全部改名']
      : ['跳过', '自动改名', '覆盖', '全部跳过', '全部改名', '全部覆盖'];
    const choice = await vscode.window.showWarningMessage(
      `「${name}」已存在，如何处理？`,
      { modal: true },
      ...buttons,
    );
    if (!choice) {
      return undefined;
    }
    const map: Record<string, { action: ConflictAction; applyAll: boolean }> = {
      跳过: { action: 'skip', applyAll: false },
      自动改名: { action: 'rename', applyAll: false },
      覆盖: { action: 'overwrite', applyAll: false },
      全部跳过: { action: 'skip', applyAll: true },
      全部改名: { action: 'rename', applyAll: true },
      全部覆盖: { action: 'overwrite', applyAll: true },
    };
    return map[choice];
  }

  private async kindOf(uri: vscode.Uri): Promise<'note' | 'folder'> {
    return (await isDir(uri)) ? 'folder' : 'note';
  }
}

function toEntries(dataTransfer: vscode.DataTransfer): [string, vscode.DataTransferItem][] {
  const entries: [string, vscode.DataTransferItem][] = [];
  dataTransfer.forEach((item, mime) => {
    entries.push([mime, item]);
  });
  return entries;
}

function linkTokens(a: vscode.CancellationToken, b: vscode.CancellationToken): vscode.CancellationToken {
  const source = new vscode.CancellationTokenSource();
  const stop = () => source.cancel();
  if (a.isCancellationRequested || b.isCancellationRequested) {
    source.cancel();
  } else {
    a.onCancellationRequested(stop);
    b.onCancellationRequested(stop);
  }
  return source.token;
}

function joinName(dir: vscode.Uri, name: string): vscode.Uri {
  return vscode.Uri.joinPath(dir, name);
}

function samePath(a: vscode.Uri, b: vscode.Uri): boolean {
  const left = path.normalize(a.fsPath);
  const right = path.normalize(b.fsPath);
  return FS_CASE_INSENSITIVE ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function findTakenUri(dir: vscode.Uri, name: string, taken: ReadonlySet<string>): vscode.Uri | undefined {
  for (const existing of taken) {
    if (FS_CASE_INSENSITIVE ? existing.toLowerCase() === name.toLowerCase() : existing === name) {
      return joinName(dir, existing);
    }
  }
  return undefined;
}

function validateDropName(name: string): string | undefined {
  if (!name || name === '.' || name === '..') {
    return '名称无效';
  }
  if (/[\\/]/.test(name)) {
    return '名称无效';
  }
  return undefined;
}

async function isDir(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return (stat.type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

async function listNames(dir: vscode.Uri): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    for (const [name] of await vscode.workspace.fs.readDirectory(dir)) {
      names.add(name);
    }
  } catch (err) {
    log.error(`读取目标目录失败：${dir.fsPath}`, err);
  }
  return names;
}

async function copyRecursive(
  source: vscode.Uri,
  target: vscode.Uri,
  overwrite: boolean,
  token: vscode.CancellationToken,
  assertActive: () => void,
  rootTarget: vscode.Uri = target,
): Promise<void> {
  if (token.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
  const stat = await vscode.workspace.fs.stat(source);
  assertActive();
  if (stat.type & vscode.FileType.Directory) {
    if (overwrite && await exists(target)) {
      await vscode.workspace.fs.delete(target, { recursive: true, useTrash: false });
    }
    await vscode.workspace.fs.createDirectory(target);
    for (const [name] of await vscode.workspace.fs.readDirectory(source)) {
      if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      const childSource = vscode.Uri.joinPath(source, name);
      // 目标落在源树内时，跳过已写入的目标子树，防止漏网时无限递归
      if (isSelfOrDescendant(rootTarget.fsPath, childSource.fsPath)) {
        continue;
      }
      await copyRecursive(
        childSource,
        vscode.Uri.joinPath(target, name),
        false,
        token,
        assertActive,
        rootTarget,
      );
    }
    return;
  }
  await vscode.workspace.fs.copy(source, target, { overwrite });
}

/**
 * 只清理本次排他创建的导入临时目录，返回 false 表示残留需同步。
 */
async function cleanupPartialImport(target: vscode.Uri, assertActive: () => void): Promise<boolean> {
  try {
    if (await exists(target)) {
      assertActive();
      await vscode.workspace.fs.delete(target, { recursive: true, useTrash: false });
    }
    return true;
  } catch (err) {
    log.error(`清理未完成导入失败：${target.fsPath}`, err);
    return false;
  }
}
