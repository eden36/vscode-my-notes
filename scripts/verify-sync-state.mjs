// 用 vscode 模块桩件验证多窗口 / 多 Profile 下的同步状态：
// 跨进程锁的互斥与过期夺取、基线清单的原子写入、损坏识别与旧目录迁移。
import { build } from 'esbuild';
import { fork } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs';
import * as fsp from 'fs/promises';
import Module from 'module';
import { tmpdir } from 'os';
import * as path from 'path';

const repoRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
);
const TMP = path.join(tmpdir(), 'mynotes-sync-state');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? '  ✔' : '  ✘'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`,
  );
}

// 被测模块直接依赖 vscode，打包成 CJS 后配合桩件加载，与 verify-activation 的做法一致
const bundle = path.join(TMP, 'sync-state.cjs');
await build({
  stdin: {
    contents:
      "export * from './src/sync/sharedState';\n" +
      "export * from './src/sync/webdav/manifest';\n" +
      "export { ActionExecutor } from './src/sync/webdav/webdavSyncProvider';",
    resolveDir: repoRoot,
    loader: 'ts',
  },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['vscode'],
  outfile: bundle,
});

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
    this.scheme = 'file';
  }
  static file(p) {
    return new Uri(path.normalize(p));
  }
  static joinPath(base, ...segs) {
    return new Uri(path.normalize(path.join(base.fsPath, ...segs)));
  }
  get path() {
    return this.fsPath.replace(/\\/g, '/');
  }
  toString() {
    return 'file:///' + this.fsPath.replace(/\\/g, '/');
  }
}

class FileSystemError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// VS Code 抛 FileSystemError，某些实现下透出的是 node 的 ENOENT，
// readManifest 两种都要能识别成「首次同步」，这里可切换以分别覆盖
let throwNodeErrors = false;

const vscode = {
  Uri,
  FileSystemError,
  CancellationError: class CancellationError extends Error {},
  workspace: {
    // 由用例按需放入「正在编辑且未保存」的文档
    textDocuments: [],
    fs: {
      async readFile(uri) {
        try {
          return new Uint8Array(await fsp.readFile(uri.fsPath));
        } catch (err) {
          if (throwNodeErrors) throw err;
          throw new FileSystemError('FileNotFound', err.message);
        }
      },
      async writeFile(uri, content) {
        await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, Buffer.from(content));
      },
      async stat(uri) {
        const st = await fsp.stat(uri.fsPath);
        return { type: st.isDirectory() ? 2 : 1, size: st.size, ctime: 0, mtime: 0 };
      },
      async createDirectory(uri) {
        await fsp.mkdir(uri.fsPath, { recursive: true });
      },
      async delete(uri, opts) {
        await fsp.rm(uri.fsPath, { recursive: Boolean(opts?.recursive), force: true });
      },
    },
  },
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, ...rest);
};

const {
  SyncLock,
  notesKey,
  readLastSyncAt,
  writeLastSyncAt,
  manifestUri,
  readManifest,
  writeManifest,
  quarantineManifest,
  migrateLegacyManifest,
  emptyManifest,
  ActionExecutor,
} = Module.createRequire(import.meta.url)(bundle);

const stateDir = Uri.file(path.join(TMP, 'state'));

console.log('笔记目录键');
{
  const base = path.join(TMP, 'notes');
  check('同一目录的不同写法解析出同一个键', notesKey(base) === notesKey(path.join(base, 'sub', '..')), true);
  check('不同目录解析出不同的键', notesKey(base) !== notesKey(path.join(TMP, 'other')), true);
  if (process.platform === 'win32') {
    check('Windows 上大小写不影响键', notesKey(base) === notesKey(base.toUpperCase()), true);
  }
}

console.log('\n跨进程同步锁');
{
  const key = 'lock-basic';
  const first = await SyncLock.acquire(stateDir, key, 'A');
  check('首次取锁成功', first !== undefined, true);

  const second = await SyncLock.acquire(stateDir, key, 'B');
  check('同一笔记目录的第二次取锁被拒绝', second, undefined);

  const other = await SyncLock.acquire(stateDir, 'lock-other', 'B');
  check('不同笔记目录互不阻塞', other !== undefined, true);
  await other?.release();

  await first.release();
  const third = await SyncLock.acquire(stateDir, key, 'B');
  check('释放后可以重新取锁', third !== undefined, true);
  await third?.release();

  check('释放后锁文件已删除', existsSync(path.join(stateDir.fsPath, `sync-${key}.lock`)), false);
}

console.log('\n过期锁处理');
{
  const key = 'lock-stale';
  const file = path.join(stateDir.fsPath, `sync-${key}.lock`);

  writeFileSync(file, JSON.stringify({ pid: 999999, device: '崩溃的窗口', startedAt: Date.now() - 60 * 1000 }));
  const fresh = await SyncLock.acquire(stateDir, key, 'A');
  check('未过期的锁不会被夺取', fresh, undefined);

  writeFileSync(file, JSON.stringify({ pid: 999999, device: '崩溃的窗口', startedAt: Date.now() - 30 * 60 * 1000 }));
  const stolen = await SyncLock.acquire(stateDir, key, 'A');
  check('超过期限的锁被清理并夺取', stolen !== undefined, true);
  await stolen?.release();

  writeFileSync(file, '这不是 JSON');
  const broken = await SyncLock.acquire(stateDir, key, 'A');
  check('锁文件内容损坏时按过期处理', broken !== undefined, true);
  await broken?.release();

  check('夺锁不会留下 .stale 残留', readdirSync(stateDir.fsPath).filter((n) => n.includes('.stale')), []);
}

console.log('\n多进程真实竞争');
{
  const key = 'lock-race';
  const worker = path.join(TMP, 'lock-worker.cjs');
  writeFileSync(
    worker,
    `const Module = require('module');
const path = require('path');
const vscode = { Uri: { file: (p) => ({ fsPath: path.normalize(p) }) } };
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, ...rest);
};
const { SyncLock } = require(process.argv[2]);
SyncLock.acquire({ fsPath: process.argv[3] }, process.argv[4], 'worker-' + process.pid)
  .then((lock) => { process.send({ acquired: Boolean(lock) }); })
  .catch(() => { process.send({ acquired: false }); });
// 抢到锁的进程必须持有到统计结束，否则其他进程会因锁被释放而误判为成功
setTimeout(() => process.exit(0), 10000);
`,
  );

  const results = await Promise.all(
    Array.from({ length: 6 }, () => {
      const child = fork(worker, [bundle, stateDir.fsPath, key], { stdio: 'ignore', silent: false });
      return new Promise((resolve) => {
        child.on('message', (msg) => {
          resolve(msg.acquired);
          child.kill();
        });
        child.on('exit', () => resolve(false));
      });
    }),
  );

  check('6 个进程同时抢锁，恰好一个成功', results.filter(Boolean).length, 1);
}

console.log('\n共享的同步时间');
{
  const key = 'state-time';
  check('尚无记录时返回 0', await readLastSyncAt(stateDir, key), 0);
  await writeLastSyncAt(stateDir, key, 1700000000000);
  check('写入后可被其他窗口读到', await readLastSyncAt(stateDir, key), 1700000000000);
}

console.log('\n基线清单读写');
{
  const uri = manifestUri(stateDir, 'https://dav.example.com', '/notes');
  check('首次同步识别为 absent 而非 corrupted', (await readManifest(uri)).status, 'absent');

  throwNodeErrors = true;
  check('透出 node ENOENT 时同样识别为 absent', (await readManifest(uri)).status, 'absent');
  throwNodeErrors = false;

  const manifest = emptyManifest();
  manifest.files['笔记.md'] = { size: 12, hash: 'H1', remoteEtag: '"E1"', remoteLastmod: 'T1' };
  await writeManifest(uri, manifest);

  const read = await readManifest(uri);
  check('写入后状态为 ok', read.status, 'ok');
  check('内容原样读回', read.manifest.files['笔记.md'], {
    size: 12,
    hash: 'H1',
    remoteEtag: '"E1"',
    remoteLastmod: 'T1',
  });
  check('记录了同步时间', typeof read.manifest.lastSyncAt, 'string');
  check('原子写入未留下临时文件', readdirSync(stateDir.fsPath).filter((n) => n.endsWith('.tmp')), []);
}

console.log('\n清单损坏识别');
{
  const uri = manifestUri(stateDir, 'https://dav.example.com', '/broken');
  await fsp.writeFile(uri.fsPath, '{ 这不是合法 JSON');
  check('无法解析时判定为 corrupted', (await readManifest(uri)).status, 'corrupted');

  await fsp.writeFile(uri.fsPath, JSON.stringify({ version: 999, files: {} }));
  check('版本不匹配时判定为 corrupted', (await readManifest(uri)).status, 'corrupted');

  await fsp.writeFile(uri.fsPath, JSON.stringify({ version: 1, files: null }));
  check('files 字段异常时判定为 corrupted', (await readManifest(uri)).status, 'corrupted');

  await quarantineManifest(uri);
  check('损坏的清单已移走', existsSync(uri.fsPath), false);
  check(
    '损坏内容留存备份便于排查',
    readdirSync(stateDir.fsPath).some((n) => n.includes('.corrupted-')),
    true,
  );
}

console.log('\n旧 Profile 目录迁移');
{
  const legacyDir = Uri.file(path.join(TMP, 'legacy-profile-storage'));
  const legacy = manifestUri(legacyDir, 'https://dav.example.com', '/migrate');
  const target = manifestUri(stateDir, 'https://dav.example.com', '/migrate');

  const old = emptyManifest();
  old.files['旧笔记.md'] = { size: 5, hash: 'OLD' };
  await writeManifest(legacy, old);

  check('迁移前目标位置为空', (await readManifest(target)).status, 'absent');
  check('迁移成功', await migrateLegacyManifest(target, legacy), true);

  const migrated = await readManifest(target);
  check('迁移后基线可用', migrated.status, 'ok');
  check('基线内容完整搬运', migrated.manifest.files['旧笔记.md'], { size: 5, hash: 'OLD' });

  const missing = manifestUri(stateDir, 'https://dav.example.com', '/never-existed');
  const absentLegacy = Uri.file(path.join(legacyDir.fsPath, 'nope.json'));
  check('旧目录没有基线时迁移返回 false', await migrateLegacyManifest(missing, absentLegacy), false);
}

// 基线里的远端 ETag 从哪来，决定了下一轮能否看见对方的改动，是最容易出错的一环
console.log('\n基线的远端 ETag 来源');
{
  const sha = (text) => createHash('sha256').update(Buffer.from(text)).digest('hex');

  /** 远端文件表由用例给出，客户端顺带记录被调用的次数以便断言 */
  function fakeClient(remoteFiles) {
    const calls = { listRemote: 0, stat: 0 };
    return {
      calls,
      async getDirectoryContents() {
        calls.listRemote++;
        return [];
      },
      async getFileContents(p) {
        return Buffer.from(remoteFiles.get(p).content);
      },
      async putFileContents(p, buf) {
        // 上传会让服务端换发新的 ETag
        remoteFiles.set(p, { content: buf.toString(), etag: '"E-上传后"', lastmod: 'T-上传后' });
        return true;
      },
      async stat(p) {
        calls.stat++;
        const f = remoteFiles.get(p);
        return { filename: p, type: 'file', size: f.content.length, etag: f.etag, lastmod: f.lastmod };
      },
      async exists() {
        return true;
      },
      async deleteFile(p) {
        remoteFiles.delete(p);
      },
      async createDirectory() {},
    };
  }

  function makeCtx(root) {
    return {
      root: Uri.file(root),
      deviceName: '测试设备',
      stateUri: stateDir,
      legacyStateUri: stateDir,
      token: { isCancellationRequested: false },
      report() {},
    };
  }

  // 双方一致、无需传输：基线应沿用同步开始时列出的 ETag，且不得再次列远端
  {
    const root = path.join(TMP, 'exec-record');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'a.md'), '同样的内容');

    const client = fakeClient(new Map([['/dav/a.md', { content: '同样的内容', etag: '"E-T0"', lastmod: 'T0' }]]));
    const local = new Map([['a.md', { size: Buffer.byteLength('同样的内容'), hash: sha('同样的内容') }]]);
    const remote = new Map([['a.md', { size: Buffer.byteLength('同样的内容'), etag: '"E-T0"', lastmod: 'T0' }]]);

    const exec = new ActionExecutor(client, makeCtx(root), '/dav', local, remote);
    await exec.run([{ type: 'record', path: 'a.md' }]);
    const files = exec.buildManifestFiles({});

    check('未传输的文件沿用同步开始时的 ETag', files['a.md'].remoteEtag, '"E-T0"');
    check('不再在同步结束后重新列一次远端', client.calls.listRemote, 0);
    check('未传输的文件无需额外 stat', client.calls.stat, 0);
  }

  // 上传：基线必须记上传后换发的新 ETag，沿用旧值会让下轮误判远端已被他人改动
  {
    const root = path.join(TMP, 'exec-upload');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'b.md'), '本地新内容');

    const client = fakeClient(new Map([['/dav/b.md', { content: '远端旧内容', etag: '"E-T0"', lastmod: 'T0' }]]));
    const local = new Map([['b.md', { size: Buffer.byteLength('本地新内容'), hash: sha('本地新内容') }]]);
    const remote = new Map([['b.md', { size: 9, etag: '"E-T0"', lastmod: 'T0' }]]);

    const exec = new ActionExecutor(client, makeCtx(root), '/dav', local, remote);
    await exec.run([{ type: 'upload', path: 'b.md' }]);
    const files = exec.buildManifestFiles({});

    check('上传后基线取的是新 ETag', files['b.md'].remoteEtag, '"E-上传后"');
    check('上传后基线的内容指纹是上传的那一版', files['b.md'].hash, sha('本地新内容'));
    check('不再在同步结束后重新列一次远端', client.calls.listRemote, 0);
  }

  // 下载：内容取自同步开始时的那一版，基线就该记那一版的 ETag
  {
    const root = path.join(TMP, 'exec-download');
    mkdirSync(root, { recursive: true });

    const client = fakeClient(new Map([['/dav/c.md', { content: '远端内容', etag: '"E-T0"', lastmod: 'T0' }]]));
    const remote = new Map([['c.md', { size: Buffer.byteLength('远端内容'), etag: '"E-T0"', lastmod: 'T0' }]]);

    const exec = new ActionExecutor(client, makeCtx(root), '/dav', new Map(), remote);
    await exec.run([{ type: 'download', path: 'c.md' }]);
    const files = exec.buildManifestFiles({});

    check('下载的内容已落盘', await fsp.readFile(path.join(root, 'c.md'), 'utf8'), '远端内容');
    check('下载后基线记录取回那一版的 ETag', files['c.md'].remoteEtag, '"E-T0"');
    check('下载计入结果', exec.result.downloaded, ['c.md']);
  }

  // 本轮处理失败的文件必须沿用旧基线，否则下轮会漏掉这处差异
  {
    const root = path.join(TMP, 'exec-failure');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'd.md'), '本地内容');

    const client = fakeClient(new Map([['/dav/d.md', { content: '远端内容', etag: '"E-T0"', lastmod: 'T0' }]]));
    client.putFileContents = async () => {
      throw new Error('网络中断');
    };
    const local = new Map([['d.md', { size: 12, hash: sha('本地内容') }]]);
    const remote = new Map([['d.md', { size: 12, etag: '"E-T0"', lastmod: 'T0' }]]);

    const exec = new ActionExecutor(client, makeCtx(root), '/dav', local, remote);
    await exec.run([{ type: 'upload', path: 'd.md' }]);
    const previous = { 'd.md': { size: 1, hash: '旧指纹', remoteEtag: '"E-旧"' } };
    const files = exec.buildManifestFiles(previous);

    check('上传失败被记录', exec.result.failures.length, 1);
    check('失败的文件沿用旧基线', files['d.md'], previous['d.md']);
    check('失败的文件不计入已上传', exec.result.uploaded, []);
  }

  // 另一个窗口正在编辑且未保存时，下载不能直接覆盖
  {
    const root = path.join(TMP, 'exec-dirty');
    mkdirSync(root, { recursive: true });
    const target = path.join(root, 'e.md');
    writeFileSync(target, '窗口里正在改的内容');

    const client = fakeClient(new Map([['/dav/e.md', { content: '远端新内容', etag: '"E-T0"', lastmod: 'T0' }]]));
    const remote = new Map([['e.md', { size: 15, etag: '"E-T0"', lastmod: 'T0' }]]);
    const local = new Map([['e.md', { size: 27, hash: sha('窗口里正在改的内容') }]]);

    vscode.workspace.textDocuments = [{ uri: Uri.file(target), isDirty: true }];
    const exec = new ActionExecutor(client, makeCtx(root), '/dav', local, remote);
    await exec.run([{ type: 'download', path: 'e.md' }]);
    vscode.workspace.textDocuments = [];

    check('未保存的内容没有被覆盖', await fsp.readFile(target, 'utf8'), '窗口里正在改的内容');
    check('不计入已下载', exec.result.downloaded, []);
    check('作为冲突提示用户', exec.result.conflicts.length, 1);

    const copies = readdirSync(root).filter((n) => n !== 'e.md');
    check('远端版本另存为副本', copies.length, 1);
    check('副本内容是远端版本', await fsp.readFile(path.join(root, copies[0]), 'utf8'), '远端新内容');
    check('该路径未写入基线，下轮会重新比对', exec.buildManifestFiles({})['e.md'], undefined);
  }
}

Module._load = originalLoad;

console.log(failures === 0 ? '\n全部检查通过' : `\n${failures} 项检查未通过`);
process.exit(failures === 0 ? 0 : 1);
