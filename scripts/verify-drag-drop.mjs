// 验证拖放导入的数据保护与跨窗口锁，全部使用隔离目录。
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { loadSource, testEnvironment, Uri } from './test-support.mjs';

const env = await testEnvironment();
let manager;
try {
  const notes = path.join(env.root, 'notes');
  await fs.mkdir(notes);
  env.settings.set('notesLocation', notes);
  const api = await loadSource("export { NotesDragDropController } from './src/notes/notesDragDrop'; export { SyncManager } from './src/sync/syncManager'; export { SyncLock } from './src/sync/syncLock'; export { notesKey } from './src/sync/sharedState';", env.vscode);
  env.vscode.workspace.fs.delete = uri => fs.rm(uri.fsPath, { recursive: true });
  env.vscode.workspace.fs.copy = (from, to, options) => fs.copyFile(from.fsPath, to.fsPath, options.overwrite ? 0 : 1);
  const controller = new api.NotesDragDropController({}, () => ({}), {});
  const token = new env.vscode.CancellationTokenSource().token;
  const original = Uri.file(path.join(notes, 'a.md'));
  await fs.writeFile(original.fsPath, '原内容');
  let result = await controller.runImports([{ uri: original, name: 'a.md' }], Uri.file(notes), token, () => {});
  assert.equal(result.successUris.length, 0);
  assert.equal(await fs.readFile(original.fsPath, 'utf8'), '原内容');
  console.log('通过 原路径导入保留原文件');

  const source = Uri.file(path.join(env.root, 'a.md'));
  await fs.writeFile(source.fsPath, '新内容');
  env.choices.push('覆盖');
  env.vscode.workspace.fs.copy = async (_from, to) => {
    await fs.writeFile(to.fsPath, '不完整内容');
    throw new Error('模拟复制失败');
  };
  result = await controller.runImports([{ uri: source, name: 'a.md' }], Uri.file(notes), token, () => {});
  assert.equal(result.successUris.length, 0);
  assert.equal(await fs.readFile(original.fsPath, 'utf8'), '原内容');
  assert.deepEqual(await fs.readdir(notes), ['a.md']);
  console.log('通过 导入失败仅清理临时目录');

  env.vscode.workspace.fs.copy = (from, to) => fs.copyFile(from.fsPath, to.fsPath, 1);
  result = await controller.runImports([{ uri: source, name: 'b.md' }], Uri.file(notes), token, () => {});
  assert.equal(result.successUris.length, 1);
  assert.equal(await fs.readFile(path.join(notes, 'b.md'), 'utf8'), '新内容');
  assert.deepEqual((await fs.readdir(notes)).sort(), ['a.md', 'b.md']);
  console.log('通过 完整导入后移入目标并清理临时目录');

  manager = new api.SyncManager(env.context);
  const key = api.notesKey(await fs.realpath(notes));
  await manager.runExclusiveLocalWrite(Uri.file(notes), async assertActive => {
    assertActive();
    assert.equal(await api.SyncLock.acquire(env.context.globalStorageUri, key, '其他窗口'), undefined);
  });
  const lease = await api.SyncLock.acquire(env.context.globalStorageUri, key, '其他窗口');
  assert.ok(lease);
  try {
    await assert.rejects(manager.runExclusiveLocalWrite(Uri.file(notes), async () => assert.fail('锁竞争时不得写盘')), /其他窗口/);
  } finally { await lease.release(); }
  console.log('通过 拖放与其他窗口共享目录锁并在结束后释放');
} finally {
  await manager?.dispose();
  await env.cleanup();
}
