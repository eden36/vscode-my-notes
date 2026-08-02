import * as assert from 'assert';
import { planSync, remoteChanged, type RemoteFile, type SyncAction } from '../sync/webdav/diff';
import type { ManifestEntry } from '../sync/webdav/manifest';
import type { LocalFile } from '../sync/webdav/scanner';

const PATH = 'note.md';

function baseEntry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return { size: 10, hash: 'H0', remoteEtag: '"E0"', remoteLastmod: 'T0', ...overrides };
}

function localFile(hash: string, size = 10): LocalFile {
  return { size, hash };
}

function remoteFile(overrides: Partial<RemoteFile> = {}): RemoteFile {
  return { size: 10, etag: '"E0"', lastmod: 'T0', ...overrides };
}

/** 只放入单个路径，断言产出的唯一动作类型 */
function planOne(
  base: ManifestEntry | undefined,
  local: LocalFile | undefined,
  remote: RemoteFile | undefined,
): SyncAction['type'] {
  const actions = planSync(
    base ? { [PATH]: base } : {},
    new Map(local ? [[PATH, local]] : []),
    new Map(remote ? [[PATH, remote]] : []),
  );
  assert.strictEqual(actions.length, 1, `期望产出 1 个动作，实际 ${actions.length} 个`);
  assert.strictEqual(actions[0].path, PATH);
  return actions[0].type;
}

describe('planSync 三方对比', () => {
  describe('无基线（首次同步或清单丢失）', () => {
    it('仅本地存在 → 上传', () => {
      assert.strictEqual(planOne(undefined, localFile('H1'), undefined), 'upload');
    });

    it('仅远端存在 → 下载', () => {
      assert.strictEqual(planOne(undefined, undefined, remoteFile()), 'download');
    });

    it('双方都存在 → 取回远端内容比对', () => {
      assert.strictEqual(planOne(undefined, localFile('H1'), remoteFile()), 'compare');
    });
  });

  describe('有基线且双方文件都在', () => {
    it('双方均未改动 → 仅记录', () => {
      assert.strictEqual(planOne(baseEntry(), localFile('H0'), remoteFile()), 'record');
    });

    it('仅本地改动 → 上传', () => {
      assert.strictEqual(planOne(baseEntry(), localFile('H1'), remoteFile()), 'upload');
    });

    it('仅远端改动 → 下载', () => {
      assert.strictEqual(planOne(baseEntry(), localFile('H0'), remoteFile({ etag: '"E1"' })), 'download');
    });

    it('双方都改动 → 取回远端内容比对', () => {
      assert.strictEqual(planOne(baseEntry(), localFile('H1'), remoteFile({ etag: '"E1"' })), 'compare');
    });
  });

  describe('远端已删除', () => {
    it('本地未改动 → 删除本地', () => {
      assert.strictEqual(planOne(baseEntry(), localFile('H0'), undefined), 'deleteLocal');
    });

    it('本地有改动 → 保留并重新上传本地，作为冲突', () => {
      assert.strictEqual(planOne(baseEntry(), localFile('H1'), undefined), 'resurrectLocal');
    });
  });

  describe('本地已删除', () => {
    it('远端未改动 → 删除远端', () => {
      assert.strictEqual(planOne(baseEntry(), undefined, remoteFile()), 'deleteRemote');
    });

    it('远端有改动 → 恢复远端版本，作为冲突', () => {
      assert.strictEqual(planOne(baseEntry(), undefined, remoteFile({ etag: '"E1"' })), 'resurrectRemote');
    });
  });

  it('双方都已删除 → 从清单移除', () => {
    assert.strictEqual(planOne(baseEntry(), undefined, undefined), 'forget');
  });

  it('取三方路径并集，且按路径排序输出', () => {
    const actions = planSync(
      { 'b.md': baseEntry() },
      new Map([['a.md', localFile('H1')]]),
      new Map([['c.md', remoteFile()]]),
    );
    assert.deepStrictEqual(
      actions.map((a) => [a.path, a.type]),
      [
        ['a.md', 'upload'],
        ['b.md', 'forget'],
        ['c.md', 'download'],
      ],
    );
  });

  it('不会为完全不存在的路径产出动作', () => {
    assert.deepStrictEqual(planSync({}, new Map(), new Map()), []);
  });
});

describe('remoteChanged 远端变更判定', () => {
  it('双方都有 ETag 时以 ETag 为准，忽略大小与时间差异', () => {
    const base = baseEntry({ remoteEtag: '"E0"', size: 10, remoteLastmod: 'T0' });
    assert.strictEqual(remoteChanged(base, { size: 999, etag: '"E0"', lastmod: 'T9' }), false);
    assert.strictEqual(remoteChanged(base, { size: 10, etag: '"E1"', lastmod: 'T0' }), true);
  });

  it('弱校验前缀与引号不影响 ETag 比较', () => {
    const base = baseEntry({ remoteEtag: 'W/"E0"' });
    assert.strictEqual(remoteChanged(base, { size: 10, etag: '"E0"', lastmod: 'T0' }), false);
    assert.strictEqual(remoteChanged(base, { size: 10, etag: 'E0', lastmod: 'T0' }), false);
  });

  it('服务端不提供 ETag 时退化为比较大小与修改时间', () => {
    const base = baseEntry({ remoteEtag: undefined });
    assert.strictEqual(remoteChanged(base, { size: 10, lastmod: 'T0' }), false);
    assert.strictEqual(remoteChanged(base, { size: 11, lastmod: 'T0' }), true);
    assert.strictEqual(remoteChanged(base, { size: 10, lastmod: 'T1' }), true);
  });

  it('基线有 ETag 但本次响应没有时，同样退化为大小与时间比较', () => {
    const base = baseEntry({ remoteEtag: '"E0"' });
    assert.strictEqual(remoteChanged(base, { size: 10, lastmod: 'T0' }), false);
    assert.strictEqual(remoteChanged(base, { size: 12, lastmod: 'T0' }), true);
  });
});
