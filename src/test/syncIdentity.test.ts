import * as assert from 'assert';
import { mkdtemp, mkdir, rm, symlink } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { SyncConfig } from '../config';
import { canonicalNotesPath, normalizeRemotePath, syncIdentity } from '../sync/syncIdentity';
import { isSyncPath } from '../sync/syncPath';
const config: SyncConfig = {
  provider: 'webdav', onStartup: false, onWindowFocus: true, focusCooldownSeconds: 300,
  onSave: false, onSaveDebounceSeconds: 30, deviceName: '测试',
  git: {
    remoteUrl: '', branch: 'main', commitMessageTemplate: '', userName: '', userEmail: ''
  },
  webdav: {
    url: 'https://example.test/dav/', username: 'A', remotePath: '/notes'
  },
};
describe('同步关系身份与路径约束', () => {
  it('不同目录和不同账号分别隔离基线', () => {
    const root = path.resolve('notes-A');
    assert.notStrictEqual(syncIdentity(root, config), syncIdentity(path.resolve('notes-B'), config));
    assert.notStrictEqual(syncIdentity(root, config), syncIdentity(root, {
      ...config, webdav: {
        ...config.webdav, username: 'B'
      }
    }));
  });
  it('同一远端目录的多余分隔符归一化', () => {
    assert.strictEqual(normalizeRemotePath('//notes///'), '/notes');
    assert.throws(() => normalizeRemotePath('/notes/../other'));
  });
  it('拒绝越级、绝对路径与系统元数据', () => {
    for (const relative of ['../a.md', '/a.md', 'a/../b.md', 'a\\b.md', '.git/config', 'C:/a.md']) {
      assert.strictEqual(isSyncPath(relative), false, relative);
    }
    assert.strictEqual(isSyncPath('工作/附件.bin'), true);
  });
  it('实际目录与目录联接使用相同身份', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'syncnotes-test-identity-'));
    try {
      const root = path.join(temporary, 'notes');
      const alias = path.join(temporary, 'alias');
      await mkdir(root);
      await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
      assert.strictEqual(await canonicalNotesPath(root), await canonicalNotesPath(alias));
    }
    finally {
      assert.strictEqual(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(temporary).startsWith('syncnotes-test-identity-'));
      await rm(temporary, {
        recursive: true, force: true
      });
    }
  });
});
