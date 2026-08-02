import * as path from 'path';
import * as vscode from 'vscode';
import { getNotesConfig, updateConfig } from '../config';
import { log } from '../log';
import { SettingsPanel } from '../settings/settingsPanel';
import { exists, listNotesRecursive, validateEntryName } from './noteFs';
import { NoteItem } from './noteItem';
import type { NotesTreeProvider } from './notesTreeProvider';

/** 大小写不敏感的文件系统上，重命名只改大小写不应被判为「已存在」 */
const FS_CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function sameName(a: string, b: string): boolean {
  return FS_CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b;
}

interface PromptOptions {
  title: string;
  prompt: string;
  parentDir: vscode.Uri;
  value?: string;
  /** 输入未带扩展名时自动补全的扩展名，仅新建/重命名笔记时传入 */
  appendExtension?: string;
  /** 重命名场景下的原名称，用于放行「改名为自己」 */
  excludeName?: string;
}

/** 解析用户输入，必要时补全扩展名 */
function resolveName(input: string, appendExtension?: string): string {
  const trimmed = input.trim();
  if (!appendExtension || path.extname(trimmed)) {
    return trimmed;
  }
  return `${trimmed}.${appendExtension}`;
}

async function promptForName(opts: PromptOptions): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    title: opts.title,
    prompt: opts.prompt,
    value: opts.value,
    valueSelection: opts.value ? [0, path.parse(opts.value).name.length] : undefined,
    validateInput: async (raw) => {
      const invalid = validateEntryName(raw);
      if (invalid) {
        return invalid;
      }
      const finalName = resolveName(raw, opts.appendExtension);
      const invalidFinal = validateEntryName(finalName);
      if (invalidFinal) {
        return invalidFinal;
      }
      if (opts.excludeName && sameName(finalName, opts.excludeName)) {
        return undefined;
      }
      if (await exists(vscode.Uri.joinPath(opts.parentDir, finalName))) {
        return `「${finalName}」已存在`;
      }
      return undefined;
    },
  });

  return input === undefined ? undefined : resolveName(input, opts.appendExtension);
}

export function registerNoteCommands(
  context: vscode.ExtensionContext,
  provider: NotesTreeProvider,
  treeView: vscode.TreeView<NoteItem>,
): void {
  /** 取得笔记根目录，未配置时引导用户先设置 */
  async function requireRoot(): Promise<vscode.Uri | undefined> {
    const root = provider.rootUri;
    if (!root) {
      const choice = await vscode.window.showWarningMessage('尚未设置笔记目录。', '选择笔记目录');
      if (choice) {
        await vscode.commands.executeCommand('mynotes.setup');
      }
      return undefined;
    }
    return root;
  }

  async function createNote(parentDir: vscode.Uri): Promise<void> {
    const cfg = getNotesConfig();
    const name = await promptForName({
      title: '新建笔记',
      prompt: `将创建在 ${parentDir.fsPath}`,
      parentDir,
      appendExtension: cfg.defaultNoteExtension,
    });
    if (!name) {
      return;
    }

    const target = vscode.Uri.joinPath(parentDir, name);
    try {
      await vscode.workspace.fs.writeFile(target, new Uint8Array());
      provider.refresh();
      const doc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(doc);
    } catch (err) {
      log.error(`新建笔记失败：${target.fsPath}`, err);
      void vscode.window.showErrorMessage(`新建笔记失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function createFolder(parentDir: vscode.Uri): Promise<void> {
    const name = await promptForName({
      title: '新建文件夹',
      prompt: `将创建在 ${parentDir.fsPath}`,
      parentDir,
    });
    if (!name) {
      return;
    }

    const target = vscode.Uri.joinPath(parentDir, name);
    try {
      await vscode.workspace.fs.createDirectory(target);
      provider.refresh();
      // 树重建是异步的，定位失败不影响创建结果
      try {
        await treeView.reveal(new NoteItem(target, 'folder'), { focus: true });
      } catch {
        /* 忽略 */
      }
    } catch (err) {
      log.error(`新建文件夹失败：${target.fsPath}`, err);
      void vscode.window.showErrorMessage(`新建文件夹失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function rename(item: NoteItem): Promise<void> {
    const parentDir = vscode.Uri.file(path.dirname(item.uri.fsPath));
    const currentName = item.name;
    const cfg = getNotesConfig();

    const name = await promptForName({
      title: item.kind === 'folder' ? '重命名文件夹' : '重命名笔记',
      prompt: '输入新名称',
      parentDir,
      value: currentName,
      appendExtension: item.kind === 'note' ? cfg.defaultNoteExtension : undefined,
      excludeName: currentName,
    });
    if (!name || sameName(name, currentName)) {
      return;
    }

    const target = vscode.Uri.joinPath(parentDir, name);
    try {
      await vscode.workspace.fs.rename(item.uri, target, { overwrite: false });
      provider.refresh();
    } catch (err) {
      log.error(`重命名失败：${item.uri.fsPath}`, err);
      void vscode.window.showErrorMessage(`重命名失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function remove(item: NoteItem): Promise<void> {
    const isFolder = item.kind === 'folder';
    const confirm = await vscode.window.showWarningMessage(
      isFolder ? `确定删除文件夹「${item.name}」及其全部内容？` : `确定删除笔记「${item.name}」？`,
      { modal: true, detail: '文件将移入回收站。' },
      '删除',
    );
    if (confirm !== '删除') {
      return;
    }

    try {
      await vscode.workspace.fs.delete(item.uri, { recursive: isFolder, useTrash: true });
      provider.refresh();
    } catch (err) {
      // 部分文件系统不支持回收站，明确询问后再永久删除
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(`移入回收站失败（${reason}），改为询问永久删除：${item.uri.fsPath}`);
      const fallback = await vscode.window.showWarningMessage(
        '无法移入回收站，是否永久删除？此操作不可撤销。',
        { modal: true },
        '永久删除',
      );
      if (fallback !== '永久删除') {
        return;
      }
      try {
        await vscode.workspace.fs.delete(item.uri, { recursive: isFolder, useTrash: false });
        provider.refresh();
      } catch (finalErr) {
        log.error(`删除失败：${item.uri.fsPath}`, finalErr);
        void vscode.window.showErrorMessage(`删除失败：${finalErr instanceof Error ? finalErr.message : String(finalErr)}`);
      }
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('mynotes.setup', async () => {
      const picked = await vscode.window.showOpenDialog({
        title: '选择笔记目录',
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: '设为笔记目录',
        defaultUri: provider.rootUri,
      });
      if (!picked?.length) {
        return;
      }
      await updateConfig('notesLocation', picked[0].fsPath);
      log.info(`笔记目录已设置为 ${picked[0].fsPath}`);
    }),

    vscode.commands.registerCommand('mynotes.createNotesLocation', async () => {
      const root = provider.rootUri;
      if (!root) {
        await vscode.commands.executeCommand('mynotes.setup');
        return;
      }
      try {
        await vscode.workspace.fs.createDirectory(root);
        provider.refresh();
        void vscode.window.showInformationMessage(`已创建笔记目录 ${root.fsPath}`);
      } catch (err) {
        log.error(`创建笔记目录失败：${root.fsPath}`, err);
        void vscode.window.showErrorMessage(`创建笔记目录失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }),

    vscode.commands.registerCommand('mynotes.newNote', async () => {
      const root = await requireRoot();
      if (root) {
        await createNote(root);
      }
    }),

    vscode.commands.registerCommand('mynotes.newNoteInFolder', async (item: NoteItem) => {
      await createNote(item.uri);
    }),

    vscode.commands.registerCommand('mynotes.newFolder', async () => {
      const root = await requireRoot();
      if (root) {
        await createFolder(root);
      }
    }),

    vscode.commands.registerCommand('mynotes.newFolderInFolder', async (item: NoteItem) => {
      await createFolder(item.uri);
    }),

    vscode.commands.registerCommand('mynotes.renameNote', (item: NoteItem) => rename(item)),
    vscode.commands.registerCommand('mynotes.renameFolder', (item: NoteItem) => rename(item)),
    vscode.commands.registerCommand('mynotes.deleteNote', (item: NoteItem) => remove(item)),
    vscode.commands.registerCommand('mynotes.deleteFolder', (item: NoteItem) => remove(item)),

    vscode.commands.registerCommand('mynotes.refresh', () => provider.refresh()),

    vscode.commands.registerCommand('mynotes.listNotes', async () => {
      const root = await requireRoot();
      if (!root) {
        return;
      }

      let notes: { uri: vscode.Uri; relativePath: string }[];
      try {
        notes = await listNotesRecursive(root, getNotesConfig());
      } catch (err) {
        log.error('检索笔记失败', err);
        void vscode.window.showErrorMessage('检索笔记失败，请确认笔记目录是否可访问。');
        return;
      }

      if (!notes.length) {
        void vscode.window.showInformationMessage('笔记目录中还没有笔记。');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        notes.map((note) => ({
          label: path.basename(note.relativePath),
          description: path.dirname(note.relativePath) === '.' ? undefined : path.dirname(note.relativePath),
          uri: note.uri,
        })),
        { title: '检索笔记', placeHolder: '输入名称筛选', matchOnDescription: true },
      );
      if (picked) {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(picked.uri));
      }
    }),

    vscode.commands.registerCommand('mynotes.revealInExplorer', async (item: NoteItem) => {
      await vscode.commands.executeCommand('revealFileInOS', item.uri);
    }),

    vscode.commands.registerCommand('mynotes.openSettings', () => {
      SettingsPanel.show(context);
    }),
  );
}
