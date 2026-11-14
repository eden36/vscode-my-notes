// 两个真实笔记仓库直接调用 GitSyncProvider，覆盖冲突、保护和恢复。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import * as fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadSource, testEnvironment, Uri } from './test-support.mjs';
const env = await testEnvironment();
const git = (cwd, args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=测试', '-c', 'user.email=test@example.invalid', ...args], {
  cwd, encoding: 'utf8', stdio: 'pipe'
});
try {
  const api = await loadSource("export { GitSyncProvider } from './src/sync/git/gitSyncProvider'; export { getSyncConfig } from './src/config'; export { buildAskpassEnv } from './src/sync/git/askpass'; export { secretKeyFor } from './src/sync/secrets';", env.vscode);
  const remote = path.join(env.root, 'remote.git');
  git(env.root, ['init', '--bare', '-b', 'main', remote]);
  env.settings.set('sync.provider', 'git');
  env.settings.set('sync.git.remoteUrl', remote);
  env.settings.set('sync.git.userName', '测试');
  env.settings.set('sync.git.userEmail', 'test@example.invalid');
  const a = path.join(env.root, 'device-A');
  const b = path.join(env.root, 'device-B');
  await fs.mkdir(a);
  await fs.mkdir(b);
  const makeContext = (root, extra = {}) => ({
    root: Uri.file(root), deviceName: path.basename(root),
    stateUri: Uri.file(path.join(env.root, 'state')), legacyStateUri: env.context.globalStorageUri,
    token: {
      isCancellationRequested: false
    }, signal: new AbortController().signal, report() {
    }, ...extra
  });
  const sync = (root, extra) => new api.GitSyncProvider(env.context, api.getSyncConfig()).sync(makeContext(root, extra));
  await fs.writeFile(path.join(a, '中文笔记.md'), '基线\n');
  await sync(a);
  await sync(b);
  assert.equal(await fs.readFile(path.join(b, '中文笔记.md'), 'utf8'), '基线\n');
  console.log('通过 首次初始化、空远端和无关历史合并');
  await fs.writeFile(path.join(a, '中文笔记.md'), '设备 A\n');
  await fs.writeFile(path.join(b, '中文笔记.md'), '设备 B\n');
  await sync(a);
  const conflict = await sync(b);
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(await fs.readFile(path.join(b, '中文笔记.md'), 'utf8'), '设备 B\n');
  assert.equal(await fs.readFile(conflict.conflicts[0].copyUri.fsPath, 'utf8'), '设备 A\n');
  assert.equal(git(b, ['ls-files', '-u']), '');
  await sync(a);
  console.log('通过 双方修改、中文路径和实际冲突副本');
  await fs.unlink(path.join(a, '中文笔记.md'));
  await fs.writeFile(path.join(b, '中文笔记.md'), '删除冲突中的修改\n');
  await sync(a);
  await sync(b);
  await sync(a);
  assert.equal(await fs.readFile(path.join(a, '中文笔记.md'), 'utf8'), '删除冲突中的修改\n');
  console.log('通过 远端删除与本地修改');
  await fs.unlink(path.join(b, '中文笔记.md'));
  await fs.writeFile(path.join(a, '中文笔记.md'), '远端需要恢复\n');
  await sync(a);
  await sync(b);
  assert.equal(await fs.readFile(path.join(b, '中文笔记.md'), 'utf8'), '远端需要恢复\n');
  console.log('通过 本地删除与远端修改');
  await fs.writeFile(path.join(a, '双方新增.md'), '新增 A');
  await fs.writeFile(path.join(b, '双方新增.md'), '新增 B');
  await sync(a);
  assert.equal((await sync(b)).conflicts.length, 1);
  await sync(a);
  console.log('通过 双方新增同名文件');
  const binary = Buffer.from([0, 255, 128, 10, 13, 42]);
  await fs.writeFile(path.join(a, '附件.bin'), binary);
  await sync(a);
  await sync(b);
  assert.deepEqual(await fs.readFile(path.join(b, '附件.bin')), binary);
  console.log('通过 二进制附件');
  const aliasB = path.join(env.root, 'device-B-alias');
  await fs.symlink(b, aliasB, process.platform === 'win32' ? 'junction' : 'dir');
  env.vscode.workspace.textDocuments = [{
    uri: Uri.file(path.join(aliasB, '中文笔记.md')), isDirty: true
  }];
  await fs.writeFile(path.join(a, '无关远端修改.md'), '可正常拉取');
  await sync(a);
  assert.equal((await sync(b)).outcome, 'complete');
  assert.equal(await fs.readFile(path.join(b, '无关远端修改.md'), 'utf8'), '可正常拉取');
  console.log('通过 无关未保存笔记不阻断同步');
  await fs.writeFile(path.join(a, '中文笔记.md'), '相关远端修改');
  await sync(a);
  const dirty = await sync(b);
  assert.equal(dirty.outcome, 'partial');
  assert.ok(dirty.deferred.length);
  env.vscode.workspace.textDocuments = [];
  await fs.writeFile(path.join(a, '中文笔记.md'), '共享编辑保护');
  await sync(a);
  const before = await fs.readFile(path.join(b, '中文笔记.md'), 'utf8');
  const sharedDirty = await sync(b, {
    isEditing: async (relative) => relative === '中文笔记.md'
  });
  assert.equal(sharedDirty.outcome, 'partial');
  assert.equal(await fs.readFile(path.join(b, '中文笔记.md'), 'utf8'), before);
  await sync(b);
  console.log('通过 目录别名下当前窗口与共享编辑状态保护');
  await fs.writeFile(path.join(a, '并发提交.md'), '本地提交');
  let changed = false;
  const deferred = await sync(a, {
    report(message) {
      if (message === '拉取远端改动' && !changed) {
        changed = true;
        writeFileSync(path.join(a, '同步期间修改.md'), '新修改');
      }
    }
  });
  assert.equal(deferred.outcome, 'partial');
  assert.ok(deferred.pendingPush.length);
  await sync(a);
  console.log('通过 提交后的磁盘修改延后与下轮恢复');
  const controller = new AbortController();
  await assert.rejects(() => sync(a, {
    signal: controller.signal, report(message) {
      if (message === '拉取远端改动') {
        controller.abort();
      }
    }
  }));
  await sync(a);
  console.log('通过 Git 请求取消与后续恢复');
  await fs.writeFile(path.join(b, '推送竞争.md'), '本地待推送');
  let pushed = false;
  const retried = await sync(b, {
    report(message) {
      if (message === '推送到远端' && !pushed) {
        pushed = true;
        writeFileSync(path.join(a, '远端竞争.md'), '另一设备的新提交');
        git(a, ['add', '-A']);
        git(a, ['commit', '-m', '测试推送竞争']);
        git(a, ['push', 'origin', 'main']);
      }
    }
  });
  assert.equal(retried.outcome, 'complete');
  assert.equal(await fs.readFile(path.join(b, '远端竞争.md'), 'utf8'), '另一设备的新提交');
  console.log('通过 推送被拒后的有限重试');
  const alternate = path.join(env.root, 'alternate.git');
  git(env.root, ['init', '--bare', '-b', 'main', alternate]);
  git(b, ['remote', 'set-url', '--push', 'origin', alternate]);
  await sync(b);
  assert.equal(git(b, ['remote', 'get-url', '--push', 'origin']).trim(), remote);
  console.log('通过 独立推送地址与配置目标一致');
  const fixtureExtension = path.join(env.root, 'fixture-extension');
  await build({ entryPoints: ['src/sync/git/askpassMain.ts'], bundle: true, platform: 'node', outfile: path.join(fixtureExtension, 'dist', 'askpassMain.js') });
  env.context.extensionUri = Uri.file(fixtureExtension);
  env.context.globalStorageUri = Uri.file(path.join(env.root, '凭据 wrapper'));
  env.secrets.set(api.secretKeyFor('git', api.getSyncConfig()), 'fixture-token');
  await sync(b);
  const askpass = await api.buildAskpassEnv(env.context, { username: 'fixture-user', password: 'fixture-token' });
  const emptyConfig = path.join(env.root, 'empty-git-config');
  await fs.writeFile(emptyConfig, '');
  const credentialEnv = { ...process.env, ...askpass, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '', GIT_TERMINAL_PROMPT: '0' };
  delete credentialEnv.GIT_DIR;
  delete credentialEnv.GIT_WORK_TREE;
  delete credentialEnv.GIT_INDEX_FILE;
  const filled = execFileSync('git', ['-c', 'credential.helper=', 'credential', 'fill'], { cwd: env.root, env: credentialEnv,
    input: 'protocol=https\nhost=example.invalid\n\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.ok(filled.includes('username=fixture-user'));
  assert.ok(filled.includes('password=fixture-token'));
  console.log('通过 访问令牌环境、真实 askpass 与含空格中文路径');
  const nested = path.join(a, 'nested');
  await fs.mkdir(nested);
  await assert.rejects(() => sync(nested), error => String(error).includes('内部'));
  env.settings.set('sync.git.branch', 'other');
  await assert.rejects(() => sync(b), error => String(error).includes('不一致'));
  console.log('通过 嵌套仓库与分支校验');
}
finally {
  await env.cleanup();
}
