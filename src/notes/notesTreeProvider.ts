import * as path from 'path';
import * as vscode from 'vscode';
import { getNotesConfig, type NotesConfig } from '../config';
import { log } from '../log';
import { isDirectory, readNoteDirectory } from './noteFs';
import { NoteItem } from './noteItem';

const REFRESH_DEBOUNCE_MS = 300;

export class NotesTreeProvider implements vscode.TreeDataProvider<NoteItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<NoteItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private config: NotesConfig = getNotesConfig();
  private watcher: vscode.FileSystemWatcher | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor() {
    void this.reconfigure();
  }

  /** 配置变更后重新读取设置、重建文件监听并刷新视图 */
  async reconfigure(): Promise<void> {
    this.config = getNotesConfig();
    this.watcher?.dispose();
    this.watcher = undefined;

    const root = this.rootUri;
    if (root) {
      this.watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(root, '**/*'),
      );
      this.watcher.onDidCreate(() => this.scheduleRefresh());
      this.watcher.onDidDelete(() => this.scheduleRefresh());
      // 内容变更不影响树结构，无需刷新
    }

    await this.updateContextKeys();
    this._onDidChangeTreeData.fire(undefined);
  }

  get rootUri(): vscode.Uri | undefined {
    return this.config.notesLocation ? vscode.Uri.file(this.config.notesLocation) : undefined;
  }

  get notesConfig(): NotesConfig {
    return this.config;
  }

  refresh(): void {
    void this.updateContextKeys();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** 批量文件变更（如同步拉取）会连续触发监听，合并成一次刷新 */
  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  private async updateContextKeys(): Promise<void> {
    const root = this.rootUri;
    const configured = root !== undefined;
    const missing = configured ? !(await isDirectory(root)) : false;
    await vscode.commands.executeCommand('setContext', 'mynotes.configured', configured);
    await vscode.commands.executeCommand('setContext', 'mynotes.locationMissing', missing);
  }

  getTreeItem(element: NoteItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: NoteItem): Promise<NoteItem[]> {
    const root = this.rootUri;
    if (!root) {
      return [];
    }
    const dir = element?.uri ?? root;

    try {
      const { folders, notes } = await readNoteDirectory(dir, this.config);
      return [
        ...folders.map((uri) => new NoteItem(uri, 'folder')),
        ...notes.map((uri) => new NoteItem(uri, 'note')),
      ];
    } catch (err) {
      // 根目录读取失败通常是路径配置错误，交给欢迎视图提示；子目录失败只记日志
      log.error(`读取目录失败：${dir.fsPath}`, err);
      return [];
    }
  }

  getParent(element: NoteItem): NoteItem | undefined {
    const root = this.rootUri;
    if (!root) {
      return undefined;
    }
    const parentPath = path.dirname(element.uri.fsPath);
    if (parentPath === element.uri.fsPath || !parentPath.startsWith(root.fsPath)) {
      return undefined;
    }
    if (path.normalize(parentPath) === path.normalize(root.fsPath)) {
      return undefined;
    }
    return new NoteItem(vscode.Uri.file(parentPath), 'folder');
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.watcher?.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
