// 使用真实 WebDAV 后端验证任务配置、取消、运行记录与关闭。
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { loadSource, testEnvironment, Uri } from './test-support.mjs';
import { webdavFixture } from './webdav-fixture.mjs';
const env = await testEnvironment();
const server = await webdavFixture();
let manager;
try {
  let notes = path.join(env.root, 'notes');
  await fs.mkdir(notes);
  env.settings.set('notesLocation', notes);
  env.settings.set('sync.provider', 'webdav');
  env.settings.set('sync.webdav.url', server.url);
  env.settings.set('sync.webdav.username', 'test-user');
  env.settings.set('sync.onStartup', false);
  const api = await loadSource("export { SyncManager } from './src/sync/syncManager'; export { getSyncConfig } from './src/config'; export { secretKeyFor } from './src/sync/secrets'; export { syncIdentity } from './src/sync/syncIdentity'; export { readRunRecord } from './src/sync/stateStore';", env.vscode);
  env.secrets.set(api.secretKeyFor('webdav', api.getSyncConfig()), 'fixture-password');
  manager = new api.SyncManager(env.context);
  const events = [];
  manager.onDidChangeState(event => events.push(event));
  await fs.writeFile(path.join(notes, 'a.md'), 'base');
  await manager.requestSync('manual');
  assert.equal(events.at(-1).state, 'complete');
  const identity = api.syncIdentity(await fs.realpath(notes), api.getSyncConfig());
  const before = await api.readRunRecord(env.context.globalStorageUri, identity);
  assert.ok(before.lastSuccessAt);
  await fs.unlink(path.join(notes, 'a.md'));
  server.failures.set('DELETE /syncnotes/a.md', 503);
  await manager.requestSync('manual');
  assert.equal(events.at(-1).state, 'partial');
  const partial = await api.readRunRecord(env.context.globalStorageUri, identity);
  assert.equal(partial.lastSuccessAt, before.lastSuccessAt);
  await manager.requestSync('manual');
  assert.equal(server.files.has('/syncnotes/a.md'), false);
  console.log('通过 协调器部分完成、成功时间和重试');
  const focusCount = events.filter(event => event.state === 'running').length;
  await manager.requestSync('focus');
  assert.equal(events.filter(event => event.state === 'running').length, focusCount);
  console.log('通过 聚焦同步的共享成功冷却');
  notes = path.join(env.root, 'created-after-configuration');
  env.settings.set('notesLocation', notes);
  await manager.reconfigure();
  await fs.mkdir(notes);
  await fs.writeFile(path.join(notes, 'new.md'), 'created later');
  await manager.requestSync('manual');
  assert.equal(events.at(-1).state, 'complete');
  assert.equal(server.files.get('/syncnotes/new.md').content.toString(), 'created later');
  console.log('通过 先配置后创建目录的同步恢复');
  env.settings.set('sync.onSave', true);
  env.settings.set('sync.onSaveDebounceSeconds', 1);
  notes = path.join(env.root, 'created-before-save');
  env.settings.set('notesLocation', notes);
  await manager.reconfigure();
  await fs.mkdir(notes);
  await fs.writeFile(path.join(notes, 'saved.md'), 'save event');
  let saveTimeout;
  let saveSubscription;
  try {
    const saved = new Promise(resolve => {
      saveSubscription = manager.onDidChangeState(event => {
        if (event.trigger === 'save' && event.state === 'complete') { resolve(); }
      });
    });
    env.documents.save.fire({ uri: Uri.file(path.join(notes, 'saved.md')) });
    await Promise.race([saved, new Promise((_, reject) => {
      saveTimeout = setTimeout(() => reject(new Error('保存同步未完成。')), 5000);
    })]);
    assert.equal(server.files.get('/syncnotes/saved.md').content.toString(), 'save event');
  } finally { clearTimeout(saveTimeout); saveSubscription?.dispose(); }
  env.documents.save.fire({ uri: Uri.file(path.join(notes, 'saved.md')) });
  env.settings.set('sync.onSave', false);
  await manager.reconfigure();
  const disabledCount = events.filter(event => event.state === 'running').length;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(events.filter(event => event.state === 'running').length, disabledCount);
  console.log('通过 保存防抖、关闭触发与异步配置切换');
  env.settings.set('sync.onStartup', true);
  await manager.reconfigure();
  let startupTimeout;
  let startupSubscription;
  try {
    const started = new Promise(resolve => {
      startupSubscription = manager.onDidChangeState(event => {
        if (event.trigger === 'startup' && event.state === 'complete') { resolve(); }
      });
    });
    manager.scheduleStartupSync();
    await Promise.race([started, new Promise((_, reject) => {
      startupTimeout = setTimeout(() => reject(new Error('启动同步未完成。')), 15_000);
    })]);
  } finally { clearTimeout(startupTimeout); startupSubscription?.dispose(); }
  env.settings.set('sync.onStartup', false);
  await manager.reconfigure();
  console.log('通过 启动同步调度');
  const other = path.join(env.root, 'other');
  const switchedIdentity = api.syncIdentity(await fs.realpath(notes), api.getSyncConfig());
  await fs.mkdir(other);
  server.beforeList.set('/syncnotes', async () => {
    env.settings.set('notesLocation', other);
    await manager.reconfigure();
  });
  await manager.requestSync('manual');
  await manager.requestSync('manual');
  assert.equal(events.at(-1).state, 'complete');
  assert.equal((await api.readRunRecord(env.context.globalStorageUri, switchedIdentity)).outcome, 'cancelled');
  console.log('通过 配置切换取消旧任务并隔离状态');
  let releaseListing;
  let notifyListing;
  const listing = new Promise(resolve => {
    notifyListing = resolve;
  });
  const release = new Promise(resolve => {
    releaseListing = resolve;
  });
  server.beforeList.set('/syncnotes', async () => {
    notifyListing();
    await release;
  });
  const running = manager.requestSync('manual');
  await listing;
  const queued = manager.requestSync('manual');
  const shutdown = manager.dispose();
  releaseListing();
  await Promise.all([running, queued, shutdown]);
  const count = events.length;
  await manager.requestSync('manual');
  assert.equal(events.length, count);
  assert.equal((await fs.readdir(env.context.globalStorageUri.fsPath)).some(name => name.startsWith('editor-')), false);
  console.log('通过 有界排队、取消和关闭后资源释放');
}
finally {
  await manager?.dispose();
  await server.close();
  await env.cleanup();
}
