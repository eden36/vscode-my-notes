import * as assert from 'assert';
import * as path from 'path';
import {
  allocateUniqueName,
  dedupeSelection,
  isNestedCopyDestination,
  isSelfOrDescendant,
  resolveDropDirectory,
} from '../notes/noteDragHelpers';

const root = path.normalize('/notes');
const folder = path.join(root, 'a');
const nested = path.join(folder, 'b.md');
const sibling = path.join(root, 'c.md');

describe('dedupeSelection', () => {
  it('去掉已被祖先覆盖的子孙', () => {
    assert.deepStrictEqual(
      dedupeSelection([folder, nested, sibling]).sort(),
      [folder, sibling].sort(),
    );
  });

  it('保留互不包含的多项', () => {
    assert.deepStrictEqual(
      dedupeSelection([nested, sibling]).sort(),
      [nested, sibling].sort(),
    );
  });
});

describe('isSelfOrDescendant', () => {
  it('识别自身与子孙', () => {
    assert.strictEqual(isSelfOrDescendant(folder, folder), true);
    assert.strictEqual(isSelfOrDescendant(folder, nested), true);
    assert.strictEqual(isSelfOrDescendant(folder, sibling), false);
  });
});

describe('resolveDropDirectory', () => {
  it('无目标时落到根', () => {
    assert.strictEqual(resolveDropDirectory(root, undefined, undefined), root);
  });

  it('文件夹落到自身，笔记落到父目录', () => {
    assert.strictEqual(resolveDropDirectory(root, folder, 'folder'), folder);
    assert.strictEqual(resolveDropDirectory(root, nested, 'note'), folder);
  });

  it('拒绝根外路径', () => {
    assert.strictEqual(resolveDropDirectory(root, path.normalize('/other'), 'folder'), undefined);
  });
});

describe('allocateUniqueName', () => {
  it('无冲突时返回原名', () => {
    assert.strictEqual(allocateUniqueName('a.md', new Set()), 'a.md');
  });

  it('按 name (n).ext 递增', () => {
    const taken = new Set(['a.md', 'a (2).md']);
    assert.strictEqual(allocateUniqueName('a.md', taken), 'a (3).md');
  });

  it('无扩展名时使用 name (n)', () => {
    assert.strictEqual(allocateUniqueName('docs', new Set(['docs'])), 'docs (2)');
  });
});

describe('isNestedCopyDestination', () => {
  it('目标目录在源目录内时判定为嵌套复制', () => {
    assert.strictEqual(isNestedCopyDestination(folder, path.join(folder, 'sub')), true);
    assert.strictEqual(isNestedCopyDestination(folder, folder), true);
  });

  it('目标在源外时允许复制', () => {
    assert.strictEqual(isNestedCopyDestination(folder, root), false);
    assert.strictEqual(isNestedCopyDestination(folder, path.join(root, 'other')), false);
  });
});
