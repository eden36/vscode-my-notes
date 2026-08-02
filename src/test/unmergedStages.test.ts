import * as assert from 'assert';
import { parseUnmergedStages, STAGE_BASE, STAGE_LOCAL, STAGE_REMOTE } from '../sync/git/unmergedStages';

const SHA = '0123456789abcdef0123456789abcdef01234567';
/** 记录分隔符。写成 '\0' 时若后面紧跟数字会被当作八进制转义，故用字符码构造 */
const NUL = String.fromCharCode(0);

/** 拼装 `git ls-files -u -z` 的真实输出格式：`<模式> <sha> <阶段>\t<路径>` + NUL */
function entries(...rows: [number, string][]): string {
  return rows.map(([stage, file]) => `100644 ${SHA} ${stage}\t${file}${NUL}`).join('');
}

describe('parseUnmergedStages 解析未合并文件阶段', () => {
  it('双方都修改时保留三个阶段', () => {
    const stages = parseUnmergedStages(
      entries([STAGE_BASE, 'note.md'], [STAGE_LOCAL, 'note.md'], [STAGE_REMOTE, 'note.md']),
    );
    assert.deepStrictEqual([...(stages.get('note.md') ?? [])].sort(), [1, 2, 3]);
  });

  it('远端删除时缺少阶段 3', () => {
    const stages = parseUnmergedStages(entries([STAGE_BASE, 'a.md'], [STAGE_LOCAL, 'a.md']));
    const set = stages.get('a.md');
    assert.strictEqual(set?.has(STAGE_LOCAL), true);
    assert.strictEqual(set?.has(STAGE_REMOTE), false);
  });

  it('本地删除时缺少阶段 2', () => {
    const stages = parseUnmergedStages(entries([STAGE_BASE, 'a.md'], [STAGE_REMOTE, 'a.md']));
    const set = stages.get('a.md');
    assert.strictEqual(set?.has(STAGE_LOCAL), false);
    assert.strictEqual(set?.has(STAGE_REMOTE), true);
  });

  it('新增/新增冲突没有基线阶段', () => {
    const stages = parseUnmergedStages(entries([STAGE_LOCAL, 'new.md'], [STAGE_REMOTE, 'new.md']));
    assert.deepStrictEqual([...(stages.get('new.md') ?? [])].sort(), [2, 3]);
  });

  it('同时解析多个冲突文件', () => {
    const stages = parseUnmergedStages(
      entries([STAGE_LOCAL, 'a.md'], [STAGE_REMOTE, 'a.md'], [STAGE_LOCAL, 'b.md']),
    );
    assert.deepStrictEqual([...stages.keys()].sort(), ['a.md', 'b.md']);
  });

  it('中文与空格路径原样保留', () => {
    const name = '工作 日志#1.md';
    const stages = parseUnmergedStages(entries([STAGE_LOCAL, name], [STAGE_REMOTE, name]));
    assert.deepStrictEqual([...stages.keys()], [name]);
  });

  it('子目录路径使用正斜杠，可直接拆分为 URI 片段', () => {
    const stages = parseUnmergedStages(entries([STAGE_LOCAL, '工作/周报.md'], [STAGE_REMOTE, '工作/周报.md']));
    assert.deepStrictEqual([...stages.keys()], ['工作/周报.md']);
  });

  it('输出为空时返回空表', () => {
    assert.strictEqual(parseUnmergedStages('').size, 0);
    assert.strictEqual(parseUnmergedStages(NUL).size, 0);
  });

  it('忽略缺少制表符或阶段号越界的异常记录', () => {
    const raw = `100644 ${SHA} 2${NUL}` + `100644 ${SHA} 7\tbad.md${NUL}` + `100644 ${SHA} 2\tgood.md${NUL}`;
    assert.deepStrictEqual([...parseUnmergedStages(raw).keys()], ['good.md']);
  });
});
