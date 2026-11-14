import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { loadSource, testEnvironment, Uri } from './test-support.mjs';
import { webdavFixture } from './webdav-fixture.mjs';
const env = await testEnvironment();
const servers = [];
try {
  const api = await loadSource("export { WebdavSyncProvider } from './src/sync/webdav/webdavSyncProvider'; export { getSyncConfig } from './src/config'; export { manifestUri } from './src/sync/webdav/manifest'; export { syncIdentity } from './src/sync/syncIdentity';", env.vscode);
  const state = Uri.file(path.join(env.root, 'state'));
  async function scenario(name, mode = 'strong', conditions = true) {
    const server = await webdavFixture({
      etags: mode, conditions
    });
    servers.push(server);
    const root = path.join(env.root, name);
    await fs.mkdir(root);
    const config = {
      ...api.getSyncConfig(), provider: 'webdav', webdav: {
        url: server.url, username: 'test-user', remotePath: '/notes'
      }
    };
    const context = (extra = {}) => ({
      root: Uri.file(root), stateUri: state, legacyStateUri: env.context.globalStorageUri,
      deviceName: name, token: {
        isCancellationRequested: false
      }, report() {
      }, ...extra
    });
    const provider = () => new api.WebdavSyncProvider(env.context, config);
    const sync = extra => provider().sync(context(extra));
    return {
      server, root, config, context, provider, sync
    };
  }
  const strong = await scenario('strong');
  await fs.writeFile(path.join(strong.root, 'a.md'), 'base');
  await strong.sync();
  assert.equal(strong.server.files.get('/notes/a.md').content.toString(), 'base');
  await fs.writeFile(path.join(strong.root, 'a.md'), 'local edit');
  strong.server.afterPut.set('/notes/a.md', () => strong.server.set('/notes/a.md', 'other device edit'));
  await strong.sync();
  await strong.sync();
  assert.equal(await fs.readFile(path.join(strong.root, 'a.md'), 'utf8'), 'other device edit');
  console.log('通过 R2 同次 PUT 响应版本与另一设备后续修改');
  strong.server.set('/notes/a.md', 'remote changed');
  strong.server.beforeList.set('/notes', () => fs.writeFile(path.join(strong.root, 'a.md'), 'local saved after scan'));
  const protectedResult = await strong.sync();
  assert.equal(await fs.readFile(path.join(strong.root, 'a.md'), 'utf8'), 'local saved after scan');
  assert.equal(protectedResult.outcome, 'partial');
  assert.ok(protectedResult.conflicts.length);
  await strong.sync();
  console.log('通过 R3 本地扫描后保存及冲突保留');
  await fs.unlink(path.join(strong.root, 'a.md'));
  strong.server.failures.set('DELETE /notes/a.md', 503);
  const failedDelete = await strong.sync();
  assert.equal(failedDelete.outcome, 'partial');
  assert.ok(failedDelete.pending.length);
  await strong.sync();
  assert.equal(strong.server.files.has('/notes/a.md'), false);
  await assert.rejects(fs.stat(path.join(strong.root, 'a.md')));
  console.log('通过 R5 远端删除失败保留依据并重试');
  strong.server.set('/notes/existing.md', 'remote original');
  const newRoot = path.join(env.root, 'new-root');
  await fs.mkdir(newRoot);
  const oldUri = api.manifestUri(state, strong.config.webdav.url, '/notes');
  await fs.writeFile(oldUri.fsPath, JSON.stringify({
    version: 1, files: {
      'existing.md': {
        size: 15, hash: 'old'
      }
    }
  }));
  const migrated = await strong.provider().sync({
    ...strong.context(), root: Uri.file(newRoot)
  });
  assert.equal(strong.server.files.get('/notes/existing.md').content.toString(), 'remote original');
  assert.equal(await fs.readFile(path.join(newRoot, 'existing.md'), 'utf8'), 'remote original');
  assert.ok(migrated.warnings.some(message => message.includes('旧同步基线')));
  assert.equal(JSON.parse(await fs.readFile(oldUri.fsPath, 'utf8')).version, 1);
  console.log('通过 R1 更换空目录与旧基线保守升级');
  const rebuilding = await scenario('partial-rebuild');
  const rebuildingUri = api.manifestUri(state, rebuilding.config.webdav.url, '/notes', api.syncIdentity(await fs.realpath(rebuilding.root), rebuilding.config));
  await fs.writeFile(rebuildingUri.fsPath, '{invalid');
  for (const name of ['edit.md', 'delete.md', 'blocked.md']) { await fs.writeFile(path.join(rebuilding.root, name), 'base'); }
  const rebuiltPartial = await rebuilding.sync({ isEditing: async relative => relative === 'blocked.md' });
  assert.equal(rebuiltPartial.outcome, 'partial');
  assert.equal(JSON.parse(await fs.readFile(rebuildingUri.fsPath, 'utf8')).rebuilding, true);
  await fs.writeFile(path.join(rebuilding.root, 'edit.md'), 'local only edit');
  await fs.unlink(path.join(rebuilding.root, 'delete.md'));
  const rebuiltNext = await rebuilding.sync();
  assert.equal(rebuiltNext.outcome, 'complete');
  assert.equal(rebuiltNext.conflicts.length, 0);
  assert.equal(rebuilding.server.files.get('/notes/edit.md').content.toString(), 'local only edit');
  assert.equal(rebuilding.server.files.has('/notes/delete.md'), false);
  await assert.rejects(fs.stat(path.join(rebuilding.root, 'delete.md')));
  console.log('通过 部分重建后的单方修改与删除');
  const leaseFailure = await scenario('checkpoint-error');
  await fs.writeFile(path.join(leaseFailure.root, 'a.md'), 'confirmed upload');
  await fs.writeFile(path.join(leaseFailure.root, 'b.md'), 'not started');
  const originalError = new Error('原始同步失败');
  let lostLease = false;
  await assert.rejects(leaseFailure.sync({
    report(message) {
      if (message.startsWith('处理 b.md')) { lostLease = true; throw originalError; }
    },
    assertActive() { if (lostLease) { throw new Error('后续检查点租约失效'); } }
  }), error => error === originalError);
  assert.equal(leaseFailure.server.files.get('/notes/a.md').content.toString(), 'confirmed upload');
  console.log('通过 检查点失败保留原始同步错误');
  const conflict = await scenario('conflict');
  await fs.writeFile(path.join(conflict.root, 'shared.md'), 'local version');
  conflict.server.set('/notes/shared.md', 'remote version');
  const conflicted = await conflict.sync();
  assert.ok(conflicted.conflicts.length);
  assert.equal(await fs.readFile(path.join(conflict.root, 'shared.md'), 'utf8'), 'local version');
  assert.ok([...conflict.server.files].some(([name, value]) => name.includes('.conflict-') && value.content.toString() === 'remote version'));
  console.log('通过 同名新增冲突与副本同步');
  const conditional = await scenario('conditional');
  await fs.writeFile(path.join(conditional.root, 'a.md'), 'base');
  await conditional.sync();
  await fs.writeFile(path.join(conditional.root, 'a.md'), 'local concurrent');
  conditional.server.beforeRequest.set('PUT /notes/a.md', () => conditional.server.set('/notes/a.md', 'remote concurrent'));
  const raced = await conditional.sync();
  assert.ok(raced.conflicts.length, JSON.stringify(raced));
  assert.equal(await fs.readFile(path.join(conditional.root, 'a.md'), 'utf8'), 'local concurrent');
  assert.ok([...conditional.server.files.values()].some(entry => entry.content.toString() === 'remote concurrent'));
  await fs.unlink(path.join(conditional.root, 'a.md'));
  conditional.server.beforeRequest.set('DELETE /notes/a.md', () => conditional.server.set('/notes/a.md', 'delete race edit'));
  await conditional.sync();
  assert.equal(await fs.readFile(path.join(conditional.root, 'a.md'), 'utf8'), 'delete race edit');
  console.log('通过 PUT 与 DELETE 执行前版本竞争及重新规划');
  for (const mode of ['weak', 'none']) {
    const compatible = await scenario(mode, mode);
    await fs.writeFile(path.join(compatible.root, 'a.md'), 'base');
    await compatible.sync();
    await compatible.sync();
    compatible.server.requests.length = 0;
    const baselineUri = api.manifestUri(state, compatible.config.webdav.url, '/notes', api.syncIdentity(await fs.realpath(compatible.root), compatible.config));
    const baselineBefore = await fs.readFile(baselineUri.fsPath, 'utf8');
    await compatible.sync();
    assert.equal(compatible.server.requests.filter(request => request.startsWith('GET ')).length, 0);
    assert.equal(await fs.readFile(baselineUri.fsPath, 'utf8'), baselineBefore);
    await fs.writeFile(path.join(compatible.root, 'a.md'), 'local modified');
    const result = await compatible.sync();
    assert.equal(compatible.server.files.get('/notes/a.md').content.toString(), 'local modified');
    assert.ok(result.warnings.length);
    compatible.server.set('/notes/a.md', 'remote modified');
    await compatible.sync();
    assert.equal(await fs.readFile(path.join(compatible.root, 'a.md'), 'utf8'), 'remote modified');
    console.log(`通过 ${mode} 验证标识兼容模式`);
  }
  const sameMetadata = await scenario('same-metadata', 'none');
  await fs.writeFile(path.join(sameMetadata.root, 'a.md'), 'ABCD');
  await sameMetadata.sync();
  const originalTime = sameMetadata.server.files.get('/notes/a.md').lastmod;
  sameMetadata.server.set('/notes/a.md', 'WXYZ');
  sameMetadata.server.files.get('/notes/a.md').lastmod = originalTime;
  const remoteOnly = await sameMetadata.sync();
  assert.equal(await fs.readFile(path.join(sameMetadata.root, 'a.md'), 'utf8'), 'ABCD');
  assert.equal(remoteOnly.conflicts.length, 0);
  await fs.writeFile(path.join(sameMetadata.root, 'a.md'), 'JKLM');
  sameMetadata.server.set('/notes/a.md', 'PQRS');
  sameMetadata.server.files.get('/notes/a.md').lastmod = originalTime;
  const bothChanged = await sameMetadata.sync();
  assert.ok(bothChanged.conflicts.length);
  assert.equal(await fs.readFile(path.join(sameMetadata.root, 'a.md'), 'utf8'), 'JKLM');
  assert.ok([...sameMetadata.server.files.values()].some(entry => entry.content.toString() === 'PQRS'));
  console.log('通过 无 ETag 元数据退化比较与写入前内容复查');
  const ignoredConditions = await scenario('ignored-conditions', 'strong', false);
  await fs.writeFile(path.join(ignoredConditions.root, 'a.md'), 'base');
  await ignoredConditions.sync();
  await fs.writeFile(path.join(ignoredConditions.root, 'a.md'), 'compatible edit');
  const ignoredResult = await ignoredConditions.sync();
  assert.equal(ignoredConditions.server.files.get('/notes/a.md').content.toString(), 'compatible edit');
  assert.ok(ignoredResult.warnings.length);
  console.log('通过 忽略条件的服务检测与兼容同步');
  const editing = await scenario('editing');
  await fs.writeFile(path.join(editing.root, 'a.md'), 'base');
  await editing.sync();
  editing.server.files.delete('/notes/a.md');
  const deferred = await editing.sync({
    isEditing: async () => true
  });
  assert.equal(deferred.outcome, 'partial');
  assert.equal(await fs.readFile(path.join(editing.root, 'a.md'), 'utf8'), 'base');
  console.log('通过 共享未保存状态保护本地删除');
  const binary = await scenario('binary');
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  binary.server.set('/notes/附件.bin', bytes);
  await binary.sync();
  assert.deepEqual(await fs.readFile(path.join(binary.root, '附件.bin')), bytes);
  console.log('通过 二进制附件和中文路径');
  const cancelled = await scenario('cancelled');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => cancelled.sync({
    signal: controller.signal
  }));
  await cancelled.sync();
  console.log('通过 取消与后续恢复');
  const uncertain = await scenario('uncertain');
  await fs.writeFile(path.join(uncertain.root, 'a.md'), 'base');
  await uncertain.sync();
  await fs.writeFile(path.join(uncertain.root, 'a.md'), 'uploaded before cancel');
  const inFlight = new AbortController();
  uncertain.server.afterPut.set('/notes/a.md', () => inFlight.abort());
  await assert.rejects(() => uncertain.sync({ signal: inFlight.signal }));
  const resumed = await uncertain.sync();
  assert.equal(resumed.outcome, 'complete');
  assert.equal(uncertain.server.files.get('/notes/a.md').content.toString(), 'uploaded before cancel');
  console.log('通过 请求执行后取消、状态提交和下轮核实');
  const filtered = await scenario('filtered');
  filtered.server.set('/notes/.DS_Store', 'system');
  filtered.server.set('/notes/visible.md', 'visible');
  await filtered.sync();
  assert.equal(await fs.readFile(path.join(filtered.root, 'visible.md'), 'utf8'), 'visible');
  await assert.rejects(fs.stat(path.join(filtered.root, '.DS_Store')));
  console.log('通过 远端系统元数据过滤');
}
finally {
  for (const server of servers) {
    await server.close();
  }
  await env.cleanup();
}
