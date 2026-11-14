// 直接验证生产锁、共享编辑状态、基线结构与运行记录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSource, testEnvironment, Uri } from './test-support.mjs';
const exportsSource = "export { SyncLock, notesKey } from './src/sync/sharedState'; export * from './src/sync/stateStore'; export * from './src/sync/webdav/manifest'; export { EditorState } from './src/sync/editorState'; export * from './src/sync/syncIdentity';";
if (process.argv[2] === '--worker') {
  const api = await loadSource(exportsSource, {
    Uri
  });
  const lease = await api.SyncLock.acquire(Uri.file(process.argv[3]), process.argv[4], '子进程');
  process.send(Boolean(lease));
  if (!lease) {
    process.exit(0);
  }
  process.on('message', async () => {
    await lease.release();
    process.exit(0);
  });
}
else {
  const env = await testEnvironment();
  const leases = [];
  const children = [];
  const editors = [];
  try {
    const api = await loadSource(exportsSource, env.vscode);
    const state = Uri.file(path.join(env.root, 'state'));
    const first = await api.SyncLock.acquire(state, 'basic', 'A');
    leases.push(first);
    assert.ok(first);
    assert.equal(await api.SyncLock.acquire(state, 'basic', 'B'), undefined);
    first.assertActive();
    await first.release();
    const next = await api.SyncLock.acquire(state, 'basic', 'B');
    leases.push(next);
    assert.ok(next);
    await next.release();
    console.log('通过 锁互斥、释放与重新获取');
    let resume;
    let notify;
    const paused = new Promise(resolve => {
      notify = resolve;
    });
    let hold = true;
    const delayed = {
      ...fs, mkdir(directory, callback) {
        fs.mkdir(directory, error => {
          if (!error && hold) {
            hold = false;
            resume = () => callback(error);
            notify();
          }
          else {
            callback(error);
          }
        });
      }
    };
    const delayedApi = await loadSource(exportsSource, env.vscode, {
      fs: delayed
    });
    const acquiring = delayedApi.SyncLock.acquire(state, 'initializing', 'A');
    await paused;
    const blocked = await api.SyncLock.acquire(state, 'initializing', 'B');
    resume();
    const initialized = await acquiring;
    leases.push(initialized);
    assert.ok(initialized);
    assert.equal(blocked, undefined);
    await initialized.release();
    console.log('通过 R4 创建尚未完成时保持互斥');
    let delayedStat;
    let statStarted;
    const heartbeatStarted = new Promise(resolve => {
      statStarted = resolve;
    });
    let holdHeartbeat = false;
    const heartbeatFs = {
      ...fs, stat(file, callback) {
        if (holdHeartbeat) {
          holdHeartbeat = false;
          delayedStat = () => fs.stat(file, callback);
          statStarted();
        }
        else {
          fs.stat(file, callback);
        }
      }
    };
    const heartbeatApi = await loadSource(exportsSource, env.vscode, {
      fs: heartbeatFs
    });
    const heartbeat = await heartbeatApi.SyncLock.acquire(state, 'heartbeat', 'A', {
      stale: 10000, update: 1000
    });
    leases.push(heartbeat);
    holdHeartbeat = true;
    let heartbeatTimeout;
    try {
      await Promise.race([heartbeatStarted, new Promise((_, reject) => {
        heartbeatTimeout = setTimeout(() => reject(new Error('心跳测试未触发。')), 5000);
      })]);
    }
    finally {
      clearTimeout(heartbeatTimeout);
    }
    await heartbeat.release();
    delayedStat();
    await new Promise(resolve => setTimeout(resolve, 30));
    const successor = await api.SyncLock.acquire(state, 'heartbeat', 'B');
    leases.push(successor);
    successor.assertActive();
    await successor.release();
    console.log('通过 心跳在途释放及后继租约保护');
    const answers = await Promise.all(Array.from({
      length: 6
    }, () => {
      const child = fork(fileURLToPath(import.meta.url), ['--worker', state.fsPath, 'race'], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
      });
      children.push(child);
      return new Promise((resolve, reject) => {
        child.once('message', resolve);
        child.once('error', reject);
        child.once('exit', code => {
          if (code) {
            reject(new Error(`锁子进程失败 ${code}`));
          }
        });
      });
    }));
    assert.equal(answers.filter(Boolean).length, 1);
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once('exit', resolve);
      if (child.connected) {
        child.send('release');
      }
    })));
    console.log('通过 六个真实进程同时取锁');
    const staleKey = 'stale';
    await fsp.mkdir(path.join(state.fsPath, `sync-${staleKey}.lock`));
    await fsp.writeFile(path.join(state.fsPath, `sync-${staleKey}.owner.json`), JSON.stringify({ pid: 99999999, token: 'expired' }));
    const expired = new Date(Date.now() - 30 * 60 * 1000);
    await fsp.utimes(path.join(state.fsPath, `sync-${staleKey}.lock`), expired, expired);
    const reclaimed = await api.SyncLock.acquire(state, staleKey, '接管进程');
    leases.push(reclaimed);
    assert.ok(reclaimed);
    reclaimed.assertActive();
    await reclaimed.release();
    console.log('通过 异常退出后的过期锁接管');
    const notes = path.join(env.root, 'notes');
    await fsp.mkdir(notes);
    await fsp.writeFile(path.join(notes, 'a.md'), '初始内容');
    const editor = new api.EditorState(state, () => {
    });
    editors.push(editor);
    await editor.setRoot(notes);
    env.vscode.workspace.textDocuments = [{
      uri: Uri.file(path.join(notes, 'a.md')), isDirty: true
    }];
    assert.equal(await editor.isEditing('a.md'), true);
    await editor.setRoot(notes);
    assert.equal(await editor.isEditing('a.md'), true);
    env.vscode.workspace.textDocuments = [];
    assert.equal(await editor.isEditing('a.md'), false);
    console.log('通过 编辑状态有序发布和保存后清除');
    const sleepingFile = path.join(state.fsPath, `editor-${api.notesKey(notes)}-sleeping.json`);
    const sleeping = { version: 1, pid: process.pid, root: notes, updatedAt: Date.now() - 300000, dirty: [] };
    await fsp.writeFile(sleepingFile, JSON.stringify(sleeping));
    assert.equal(await editor.isEditing('a.md'), false);
    sleeping.dirty = ['a.md'];
    await fsp.writeFile(sleepingFile, JSON.stringify(sleeping));
    assert.equal(await editor.isEditing('a.md'), true);
    assert.equal(await editor.isEditing('other.md'), false);
    await fsp.unlink(sleepingFile);
    const alias = path.join(env.root, 'notes-alias');
    await fsp.symlink(notes, alias, process.platform === 'win32' ? 'junction' : 'dir');
    env.vscode.workspace.textDocuments = [{ uri: Uri.file(path.join(alias, 'new.md')), isDirty: true }];
    assert.equal(await editor.isEditing('new.md'), true);
    assert.equal(await api.canonicalFilePath(path.join(alias, 'new.md')), path.join(await fsp.realpath(notes), 'new.md'));
    env.vscode.workspace.textDocuments = [];
    console.log('通过 休眠窗口逐文件保护与未落盘文档目录别名');
    const manifest = api.emptyManifest('target-A');
    manifest.files['a.md'] = {
      size: 1, hash: 'hash-A', remoteEtag: '"E1"'
    };
    const uri = api.manifestUri(state, 'https://example.test', '/notes', 'target-A');
    await api.writeManifest(uri, manifest);
    assert.equal((await api.readManifest(uri, 'target-A')).status, 'ok');
    assert.equal((await api.readManifest(uri, 'target-B')).status, 'corrupted');
    await fsp.writeFile(uri.fsPath, '{invalid');
    assert.equal((await api.readManifest(uri, 'target-A')).status, 'corrupted');
    await api.quarantineManifest(uri);
    assert.ok((await fsp.readdir(state.fsPath)).some(file => file.includes('.corrupted-')));
    assert.equal(await fsp.readFile(uri.fsPath, 'utf8'), '{invalid');
    console.log('通过 基线校验、身份检查和损坏留存');
    await api.writeRunRecord(state, 'run', {
      version: 2, lastAttemptAt: 20, lastSuccessAt: 10, outcome: 'partial'
    });
    assert.equal((await api.readRunRecord(state, 'run')).lastSuccessAt, 10);
    console.log('通过 尝试时间与成功时间独立记录');
  }
  finally {
    for (const editor of editors) {
      await editor.dispose();
    }
    for (const lease of leases) {
      await lease?.release();
    }
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill();
      }
    }
    await env.cleanup();
  }
}
