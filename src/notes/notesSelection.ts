import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../log';
import { isInside } from '../sync/syncPath';
import type { NoteItem } from './noteItem';
import type { NotesTreeProvider } from './notesTreeProvider';

/** 跟随活动笔记定位树节点，保持编辑器焦点且不主动显示隐藏的侧栏。 */
export function registerNoteSelection(
  context: vscode.ExtensionContext,
  provider: NotesTreeProvider,
  treeView: vscode.TreeView<NoteItem>,
): void {
  let revision = 0;
  let disposed = false;
  let pending = Promise.resolve();
  let lastTab: vscode.Tab | undefined;
  let lastResource: string | undefined;

  const followActiveNote = (force = true): Promise<void> => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab?.input;
    const uri = input instanceof vscode.TabInputText ||
      (input instanceof vscode.TabInputCustom && input.viewType === 'vscode.markdown.preview.editor')
      ? input.uri : undefined;
    // 保存、固定标签等也会触发 tab 事件，只有活动目标变化时才重新选中。
    if (!force && tab === lastTab && uri?.toString() === lastResource) { return pending; }
    lastTab = tab;
    lastResource = uri?.toString();
    const current = ++revision;
    // 串行执行 reveal；过期请求停止查找，最后一次切换决定最终选中项。
    pending = pending.then(async () => {
      if (disposed || current !== revision || !treeView.visible) { return; }
      const root = provider.rootUri;
      if (!root || uri?.scheme !== 'file' || !isInside(root.fsPath, uri.fsPath)) { return; }
      const relative = path.relative(root.fsPath, uri.fsPath);
      if (!relative) { return; }
      const segments = relative.split(path.sep);
      if (segments.some(segment => segment.startsWith('.'))) { return; }

      // 沿父目录逐层查找，复用笔记树的过滤规则及实际文件名大小写。
      let item: NoteItem | undefined;
      for (const [index, segment] of segments.entries()) {
        const children = await provider.getChildren(item);
        if (disposed || current !== revision || !treeView.visible) { return; }
        item = children.find(child => process.platform === 'win32'
          ? child.name.toLowerCase() === segment.toLowerCase() : child.name === segment);
        if (!item || (index < segments.length - 1 && item.kind !== 'folder')) { return; }
      }
      if (!item || item.kind !== 'note') { return; }
      await treeView.reveal(item, { select: true, focus: false });
    }).catch(error => {
      if (!disposed && current === revision) { log.error('定位活动笔记失败', error); }
    });
    return pending;
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => followActiveNote(false)),
    vscode.window.tabGroups.onDidChangeTabs(() => followActiveNote(false)),
    vscode.window.tabGroups.onDidChangeTabGroups(() => followActiveNote(false)),
    treeView.onDidChangeVisibility(() => followActiveNote()),
    provider.onDidChangeTreeData(() => followActiveNote()),
    { dispose: () => { disposed = true; revision++; } },
  );
  void followActiveNote();
}
