import { deepStrictEqual, strictEqual } from 'assert';
import { TextMatcher, literalPattern } from '../notes/noteSearchText';

describe('笔记正文匹配', () => {
  it('跨块统计非重叠出现次数并保留首个 UTF-16 偏移', () => {
    const matcher = new TextMatcher('Ab');
    for (const part of ['😀a', 'B ab', 'AB', 'x']) { matcher.push(part); }
    matcher.push('', true);
    const result = matcher.result();
    strictEqual(result.count, 3);
    strictEqual(result.firstOffset, 2);
    strictEqual(result.firstLength, 2);
    strictEqual(result.snippet, '😀aB abABx');
  });

  it('按字面量和 Unicode 简单大小写匹配', () => {
    deepStrictEqual(Array.from('KKk'.matchAll(literalPattern('k')), match => match[0]), ['K', 'K', 'k']);
    const matcher = new TextMatcher('a.a');
    matcher.push('a.a aXa a.a', true);
    strictEqual(matcher.result().count, 2);
  });

  it('不重叠统计并处理无匹配', () => {
    const matcher = new TextMatcher('aa');
    matcher.push('aaaaa', true);
    strictEqual(matcher.result().count, 2);
    const missing = new TextMatcher('x');
    missing.push('abc', true);
    strictEqual(missing.result().firstOffset, undefined);
  });

  it('不同分块边界下与整段文本的匹配一致', () => {
    const input = '😀Ababa Kk\r\n ABa😀aBa';
    for (const query of ['aba', 'ab', 'k', '😀a', '\r\n']) {
      const expected = Array.from(input.matchAll(literalPattern(query)));
      for (let size = 1; size <= 9; size++) {
        const matcher = new TextMatcher(query);
        for (let index = 0; index < input.length; index += size) { matcher.push(input.slice(index, index + size)); }
        matcher.push('', true);
        strictEqual(matcher.result().count, expected.length, `${query} / ${size}`);
        strictEqual(matcher.result().firstOffset, expected[0]?.index, `${query} / ${size}`);
      }
    }
  });

  it('首处片段按固定范围截取且不会重复拼接', () => {
    const input = `${'x'.repeat(200)}abc${'y'.repeat(200)}`;
    const matcher = new TextMatcher('abc');
    for (let index = 0; index < input.length; index += 17) { matcher.push(input.slice(index, index + 17)); }
    matcher.push('', true);
    strictEqual(matcher.result().snippet, `${'x'.repeat(60)}abc${'y'.repeat(60)}`);
  });
});
