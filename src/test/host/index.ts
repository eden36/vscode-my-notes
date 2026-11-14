import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { EditorState } from '../../sync/editorState';
import { NotesTreeProvider } from '../../notes/notesTreeProvider';
async function waitFor(file: string): Promise<void> {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      await fs.stat(file);
      return;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`宿主协调等待超时：${path.basename(file)}`);
}
/** 真实编辑器 API 验收，两个独立用户数据目录共享测试编辑状态。 */
export async function run(): Promise<void> {
  const owned = !process.env['SYNCNOTES_HOST_TEST_ROOT'];
  const root = process.env['SYNCNOTES_HOST_TEST_ROOT'] ?? await fs.mkdtemp(path.join(os.tmpdir(), 'syncnotes-test-host-'));
  const role = process.env['SYNCNOTES_HOST_TEST_ROLE'] ?? 'single';
  const notes = path.join(root, 'notes');
  await fs.mkdir(notes, {
    recursive: true
  });
  const file = path.join(notes, 'a.md');
  try {
    await fs.writeFile(file, '宿主测试笔记\n', {
      flag: 'wx'
    });
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
  const configuration = vscode.workspace.getConfiguration('syncnotes');
  await configuration.update('notesLocation', notes, vscode.ConfigurationTarget.Global);
  await configuration.update('sync.provider', 'none', vscode.ConfigurationTarget.Global);
  await configuration.update('sync.onStartup', false, vscode.ConfigurationTarget.Global);
  const extension = vscode.extensions.getExtension('saltcoreyan.syncnotes');
  assert.ok(extension, '缺少待测试的 SyncNotes 扩展。');
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['syncnotes.newNote', 'syncnotes.openSettings', 'syncnotes.sync']) {
    assert.ok(commands.includes(command), `缺少命令：${command}`);
  }
  assert.strictEqual(configuration.inspect('notesLocation')?.globalValue, notes);
  const tree = new NotesTreeProvider();
  const editors = new EditorState(vscode.Uri.file(path.join(root, 'shared-state')), () => undefined);
  try {
    await tree.reconfigure();
    assert.ok((await tree.getChildren()).some(item => item.name === 'a.md'));
    await editors.setRoot(await fs.realpath(notes));
    if (role === 'editor') {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(document);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, new vscode.Position(0, 0), '未保存的修改\n');
      assert.ok(await vscode.workspace.applyEdit(edit));
      assert.ok(document.isDirty);
      assert.ok(await editors.isEditing('a.md'));
      await fs.writeFile(path.join(root, 'editor-ready'), 'ready');
      await waitFor(path.join(root, 'save-editor'));
      assert.ok(await document.save());
      assert.strictEqual(await editors.isEditing('a.md'), false);
      await fs.writeFile(path.join(root, 'editor-saved'), 'saved');
      await waitFor(path.join(root, 'release-editor'));
    }
    else if (role === 'observer') {
      await waitFor(path.join(root, 'editor-ready'));
      assert.ok(await editors.isEditing('a.md'));
      await fs.writeFile(path.join(root, 'save-editor'), 'save');
      await waitFor(path.join(root, 'editor-saved'));
      assert.strictEqual(await editors.isEditing('a.md'), false);
      await fs.writeFile(path.join(root, 'release-editor'), 'release');
    }
    await vscode.commands.executeCommand('syncnotes.openSettings');
    const tabDeadline = Date.now() + 10000;
    while (!vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview)) && Date.now() < tabDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview)));
    await vscode.commands.executeCommand('syncnotes.refresh');
    await fs.writeFile(path.join(root, `${role}-passed.json`), JSON.stringify({
      role, activation: true, tree: true, settings: true, editing: true
    }));
  }
  finally {
    tree.dispose();
    await editors.dispose();
    if (owned) {
      await fs.rm(root, {
        recursive: true, force: true
      });
    }
  }
}
