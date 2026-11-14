// 固化架构评估中的身份、版本、文件写入和失败恢复缺陷。
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { loadSource, testEnvironment, Uri } from './test-support.mjs';
const env = await testEnvironment();
let failures = 0;
async function check(label, action) {
  try {
    await action();
    console.log(`通过 ${label}`);
  }
  catch (error) {
    failures++;
    console.error(`失败 ${label} — ${error.message}`);
  }
}
try {
  const api = await loadSource("export { manifestUri } from './src/sync/webdav/manifest'; export { ActionExecutor } from './src/sync/webdav/webdavSyncProvider'; export { planSync } from './src/sync/webdav/diff'; export { hashContent } from './src/sync/webdav/scanner';", env.vscode);
  const state = Uri.file(path.join(env.root, 'state'));
  const root = Uri.file(path.join(env.root, 'notes'));
  await fs.mkdir(root.fsPath);
  const ctx = {
    root, stateUri: state, legacyStateUri: state, deviceName: '测试设备', token: {
      isCancellationRequested: false
    }, report() {
    }
  };
  const base = {
    'a.md': {
      size: 3, hash: api.hashContent(Buffer.from('old')), remoteEtag: '"E0"'
    }
  };
  const remote = new Map([['a.md', {
    size: 3, etag: '"E0"'
  }]]);
  await check('R1 不同同步关系使用独立基线', () => {
    assert.notEqual(api.manifestUri(state, 'https://example.test', '/notes', 'root-A-user-A').fsPath, api.manifestUri(state, 'https://example.test', '/notes', 'root-B-user-A').fsPath);
  });
  await check('R5 远端删除失败后继续重试删除', async () => {
    const executor = new api.ActionExecutor({
      async deleteFile() {
        throw new Error('网络中断');
      }
    }, ctx, '/notes', new Map(), remote);
    await executor.run([{
      type: 'deleteRemote', path: 'a.md'
    }]);
    const next = api.planSync(executor.buildManifestFiles(base), new Map(), remote);
    assert.equal(next[0].type, 'deleteRemote');
  });
  const target = path.join(root.fsPath, 'a.md');
  await check('R3 扫描后保存的本地修改得到保留', async () => {
    await fs.writeFile(target, '扫描后的新修改');
    const local = new Map([['a.md', {
      size: 3, hash: api.hashContent(Buffer.from('old'))
    }]]);
    const executor = new api.ActionExecutor({
      async getFileContents() {
        return Buffer.from('远端修改');
      }
    }, ctx, '/notes', local, remote);
    await executor.run([{
      type: 'download', path: 'a.md'
    }]);
    assert.equal(await fs.readFile(target, 'utf8'), '扫描后的新修改');
  });
  await check('R2 上传后另一设备修改仍能在下轮识别', async () => {
    await fs.writeFile(target, 'my content');
    const local = new Map([['a.md', {
      size: 10, hash: api.hashContent(Buffer.from('my content'))
    }]]);
    const client = {
      async putFileContents() {
        return true;
      },
      async stat() {
        return {
          size: 20, etag: '"E2"'
        };
      },
      async getFileContents() {
        return {
          data: Buffer.from('other device content'), headers: {
            etag: '"E2"'
          }
        };
      },
    };
    const executor = new api.ActionExecutor(client, ctx, '/notes', local, remote);
    await executor.run([{
      type: 'upload', path: 'a.md'
    }]);
    const next = api.planSync(executor.buildManifestFiles(base), local, new Map([['a.md', {
      size: 20, etag: '"E2"'
    }]]));
    assert.notEqual(next[0].type, 'record');
  });
  await check('不支持硬链接时排他创建文件', async () => {
    const localApi = await loadSource("export * from './src/sync/localFileStore';", env.vscode, {
      'fs/promises': { ...fs, async link() { throw Object.assign(new Error('不支持硬链接'), { code: 'ENOTSUP' }); } }
    });
    await new localApi.LocalFileStore(ctx).write('fallback.md', Buffer.from('fallback'), undefined);
    assert.equal(await fs.readFile(path.join(root.fsPath, 'fallback.md'), 'utf8'), 'fallback');
  });
  await check('排他创建竞争保留其他写入并识别本地变化', async () => {
    for (const mode of ['link', 'copy']) {
      const file = `${mode}-race.md`;
      const localApi = await loadSource("export * from './src/sync/localFileStore';", env.vscode, {
        'fs/promises': { ...fs,
          async link(_source, destination) {
            if (mode === 'copy') { throw Object.assign(new Error('不支持硬链接'), { code: 'ENOTSUP' }); }
            await fs.writeFile(destination, 'other writer');
            throw Object.assign(new Error('文件已存在'), { code: 'EEXIST' });
          },
          async copyFile(source, destination, flags) {
            await fs.writeFile(destination, 'other writer');
            return fs.copyFile(source, destination, flags);
          }
        }
      });
      await assert.rejects(new localApi.LocalFileStore(ctx).write(file, Buffer.from('download'), undefined), localApi.LocalChangedError);
      assert.equal(await fs.readFile(path.join(root.fsPath, file), 'utf8'), 'other writer');
    }
  });
  await check('目录别名下当前窗口未保存文档受到保护', async () => {
    const alias = path.join(env.root, 'notes-alias');
    await fs.symlink(root.fsPath, alias, process.platform === 'win32' ? 'junction' : 'dir');
    env.vscode.workspace.textDocuments = [{ uri: Uri.file(path.join(alias, 'new.md')), isDirty: true }];
    const localApi = await loadSource("export * from './src/sync/localFileStore';", env.vscode);
    await assert.rejects(new localApi.LocalFileStore(ctx).write('new.md', Buffer.from('download'), undefined), localApi.LocalChangedError);
    env.vscode.workspace.textDocuments = [];
  });
}
finally {
  await env.cleanup();
}
process.exitCode = failures ? 1 : 0;
