import * as path from 'path';
import * as vscode from 'vscode';

export type NoteKind = 'note' | 'folder';

export class NoteItem extends vscode.TreeItem {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly kind: NoteKind,
  ) {
    super(uri, kind === 'folder' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);

    // resourceUri 已提供标签与图标，这里只补充点击行为与右键菜单所需的 contextValue
    this.contextValue = kind;
    this.tooltip = uri.fsPath;
    // 设定稳定 id，使刷新后展开状态得以保留，且 TreeView.reveal 能按路径定位
    this.id = uri.toString();

    if (kind === 'note') {
      this.command = {
        command: 'vscode.open',
        title: '打开笔记',
        arguments: [uri],
      };
    }
  }

  get name(): string {
    return path.basename(this.uri.fsPath);
  }
}
