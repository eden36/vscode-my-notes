import * as assert from 'assert';
import { conflictFileName, formatTimestamp, isConflictFileName } from '../sync/conflictName';

const DATE = new Date(2026, 7, 2, 17, 15, 30); // 2026-08-02 17:15:30

describe('conflictFileName 冲突副本命名', () => {
  it('保留原扩展名，便于副本照常作为笔记打开', () => {
    assert.strictEqual(
      conflictFileName('工作日志.md', 'DESKTOP-ABC', DATE),
      '工作日志.conflict-DESKTOP-ABC-20260802-171530.md',
    );
  });

  it('无扩展名的文件也能正确命名', () => {
    assert.strictEqual(conflictFileName('LICENSE', 'pc', DATE), 'LICENSE.conflict-pc-20260802-171530');
  });

  it('只替换最后一个扩展名', () => {
    assert.strictEqual(
      conflictFileName('归档.tar.gz', 'pc', DATE),
      '归档.tar.conflict-pc-20260802-171530.gz',
    );
  });

  it('设备名中的非法字符会被替换，避免生成无效文件名', () => {
    assert.strictEqual(
      conflictFileName('a.md', 'my pc/工作:机', DATE),
      'a.conflict-my-pc-工作-机-20260802-171530.md',
    );
  });

  it('设备名为空或全是非法字符时回退为 unknown', () => {
    assert.strictEqual(conflictFileName('a.md', '', DATE), 'a.conflict-unknown-20260802-171530.md');
    assert.strictEqual(conflictFileName('a.md', '///', DATE), 'a.conflict-unknown-20260802-171530.md');
  });
});

describe('formatTimestamp 时间戳格式', () => {
  it('月日时分秒补零到两位', () => {
    assert.strictEqual(formatTimestamp(new Date(2026, 0, 5, 3, 4, 9)), '20260105-030409');
  });
});

describe('isConflictFileName 冲突副本识别', () => {
  it('识别本插件生成的副本', () => {
    assert.ok(isConflictFileName('工作日志.conflict-DESKTOP-ABC-20260802-171530.md'));
    assert.ok(isConflictFileName('LICENSE.conflict-pc-20260802-171530'));
    assert.ok(isConflictFileName('a.conflict-pc-20260802-171530-2.md'));
  });

  it('不误判普通笔记', () => {
    assert.strictEqual(isConflictFileName('工作日志.md'), false);
    assert.strictEqual(isConflictFileName('conflict.md'), false);
    assert.strictEqual(isConflictFileName('a.conflict-pc.md'), false);
  });
});
