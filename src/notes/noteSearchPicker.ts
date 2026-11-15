import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_SECTION, getNotesConfig } from '../config';
import { matchDocument, searchNotes, type NoteSearchResult } from './noteSearch';

interface SearchItem extends vscode.QuickPickItem {
  result?: NoteSearchResult;
  more?: boolean;
}

/** 管理单个搜索框及其查询进程。 */
export class NoteSearchPicker implements vscode.Disposable {
  private picker: vscode.QuickPick<SearchItem> | undefined;
  private abort: AbortController | undefined;
  private timer: NodeJS.Timeout | undefined;
  private generation = 0;
  private readonly tasks = new Set<Promise<void>>();

  constructor(private readonly extensionPath: string) {}

  show(initialQuery?: string): void {
    if (this.picker) {
      if (initialQuery !== undefined) { this.picker.value = initialQuery; }
      this.picker.show();
      return;
    }
    const picker = vscode.window.createQuickPick<SearchItem>();
    this.picker = picker;
    picker.title = '搜索笔记';
    picker.placeholder = '输入关键词，搜索名称和 UTF-8 正文';
    picker.matchOnDescription = false;
    picker.matchOnDetail = false;
    let results: NoteSearchResult[] = [];
    let visible = 500;
    let incomplete = false;
    let watcher: vscode.FileSystemWatcher | undefined;
    const disposables: vscode.Disposable[] = [];

    const render = () => {
      const sorted = [...results].sort((a, b) => Number(b.nameMatch) - Number(a.nameMatch) || a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true, sensitivity: 'base' }));
      const items: SearchItem[] = [];
      let previous: boolean | undefined;
      for (const result of sorted.slice(0, visible)) {
        if (result.nameMatch !== previous) {
          previous = result.nameMatch;
          items.push({ label: previous ? '名称匹配' : '正文匹配', kind: vscode.QuickPickItemKind.Separator });
        }
        const directory = path.posix.dirname(result.relativePath);
        const labels = [directory === '.' ? '' : directory, result.nameMatch ? '名称匹配' : '', result.failed ? '正文统计失败' : result.count === undefined ? '正文统计中' : result.count > 0 ? result.verified ? `正文 ${result.count} 处` : '正文校验中' : ''].filter(Boolean);
        items.push({ label: path.posix.basename(result.relativePath), description: labels.join(' · '), detail: result.snippet, alwaysShow: true, result });
      }
      if (sorted.length > visible) { items.push({ label: `加载更多（还有 ${sorted.length - visible} 篇）`, alwaysShow: true, more: true }); }
      picker.items = items;
      picker.title = `搜索笔记${sorted.length ? ` · ${sorted.length} 篇` : ''}${incomplete ? ' · 结果可能不完整' : ' · UTF-8 文本'}`;
    };
    const schedule = () => {
      this.abort?.abort();
      if (this.timer) { clearTimeout(this.timer); }
      const generation = ++this.generation;
      results = [];
      visible = 500;
      incomplete = false;
      render();
      const query = picker.value;
      if (!query) { picker.busy = false; return; }
      picker.busy = true;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        const cfg = getNotesConfig([]);
        if (!cfg.notesLocation) { picker.busy = false; picker.title = '搜索笔记 · 尚未设置笔记目录'; return; }
        const controller = new AbortController();
        this.abort = controller;
        const binary = path.join(this.extensionPath, 'dist', 'ripgrep', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'rg.exe' : 'rg');
        const task = searchNotes(vscode.Uri.file(cfg.notesLocation), cfg, query, binary, controller.signal, (next, partial) => {
          if (this.picker !== picker || generation !== this.generation) { return; }
          results = next;
          incomplete = partial;
          render();
        }).catch(error => {
          if (!controller.signal.aborted && !(error instanceof vscode.CancellationError) && this.picker === picker && generation === this.generation) {
            picker.title = `搜索失败：${error instanceof Error ? error.message : String(error)}`;
          }
        }).finally(() => {
          this.tasks.delete(task);
          if (this.picker === picker && generation === this.generation) { picker.busy = false; }
        });
        this.tasks.add(task);
      }, 250);
    };
    const refreshWatcher = () => {
      watcher?.dispose();
      const root = getNotesConfig([]).notesLocation;
      watcher = root ? vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**/*')) : undefined;
      if (watcher) {
        watcher.onDidCreate(schedule);
        watcher.onDidChange(schedule);
        watcher.onDidDelete(schedule);
      }
    };
    const isRelevant = (document: vscode.TextDocument) => {
      const root = getNotesConfig([]).notesLocation;
      if (!root || document.uri.scheme !== 'file') { return false; }
      const relative = path.relative(root, document.uri.fsPath);
      return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    refreshWatcher();
    disposables.push(
      picker.onDidChangeValue(schedule),
      picker.onDidAccept(() => {
        const item = picker.selectedItems[0];
        if (item?.more) { visible += 500; render(); return; }
        if (!item?.result) { return; }
        const selected = item.result;
        const query = picker.value;
        picker.hide();
        void (async () => {
          try {
            const document = await vscode.workspace.openTextDocument(selected.uri);
            const editor = await vscode.window.showTextDocument(document);
            if ((selected.count ?? 0) > 0) {
              const found = await matchDocument(document, query, new AbortController().signal);
              if (found.firstOffset === undefined || found.firstLength === undefined) {
                void vscode.window.showInformationMessage('笔记内容已变化，请重新搜索。');
                return;
              }
              const start = document.positionAt(found.firstOffset);
              const end = document.positionAt(found.firstOffset + found.firstLength);
              editor.selection = new vscode.Selection(start, end);
              editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
            }
          } catch (error) {
            void vscode.window.showErrorMessage(`打开笔记失败：${error instanceof Error ? error.message : String(error)}`);
          }
        })();
      }),
      vscode.workspace.onDidChangeTextDocument(event => { if (isRelevant(event.document)) { schedule(); } }),
      vscode.workspace.onDidSaveTextDocument(document => { if (isRelevant(document)) { schedule(); } }),
      vscode.workspace.onDidCloseTextDocument(document => { if (isRelevant(document)) { schedule(); } }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(CONFIG_SECTION)) { refreshWatcher(); schedule(); }
      }),
      picker.onDidHide(() => {
        this.abort?.abort();
        this.abort = undefined;
        if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
        this.generation++;
        watcher?.dispose();
        for (const disposable of disposables) { disposable.dispose(); }
        this.picker = undefined;
        picker.dispose();
      }),
    );
    if (initialQuery !== undefined) { picker.value = initialQuery; }
    picker.show();
  }

  dispose(): void { this.picker?.hide(); this.abort?.abort(); }

  /** 停用时等待已取消进程退出。 */
  async shutdown(): Promise<void> {
    this.dispose();
    await Promise.allSettled([...this.tasks]);
  }
}
