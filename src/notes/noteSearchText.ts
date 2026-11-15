/** 单篇正文的匹配结果，位置使用 UTF-16 偏移。 */
export interface TextMatch {
  count: number;
  firstOffset?: number;
  firstLength?: number;
  snippet?: string;
}

/** 字面量匹配使用 Unicode 简单大小写折叠，与 ripgrep 的大小写模式保持一致。 */
export function literalPattern(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
}

/** 分块统计非重叠匹配，避免为每个命中保存对象。 */
export class TextMatcher {
  private readonly pattern: RegExp;
  private pending = '';
  private processed = 0;
  private prefix = '';
  private firstOffset: number | undefined;
  private firstLength: number | undefined;
  private snippet = '';
  private count = 0;

  constructor(private readonly query: string) {
    if (!query) { throw new Error('搜索关键词不能为空。'); }
    this.pattern = literalPattern(query);
  }

  push(chunk: string, final = false): void {
    const text = this.pending + chunk;
    const safeEnd = final ? text.length : Math.max(0, text.length - this.query.length - 2);
    let consumed = 0;
    this.pattern.lastIndex = 0;
    for (;;) {
      const match = this.pattern.exec(text);
      if (!match || (!final && match.index >= safeEnd)) { break; }
      if (this.firstOffset === undefined) {
        this.firstOffset = this.processed + match.index;
        this.firstLength = match[0].length;
        this.snippet = (this.prefix + text.slice(0, match.index)).slice(-60) + text.slice(match.index, match.index + match[0].length + 60);
      }
      this.count++;
      consumed = this.pattern.lastIndex;
    }
    const cut = Math.max(consumed, safeEnd);
    if (this.firstOffset !== undefined && this.snippet.length < 120 + (this.firstLength ?? 0)) {
      // 首个匹配附近的文本可能跨块，后续补齐片段。
      const firstEnd = this.firstOffset + (this.firstLength ?? 0);
      const availableEnd = this.processed + text.length;
      const currentEnd = firstEnd + Math.max(0, this.snippet.length - (this.firstLength ?? 0) - Math.min(60, this.firstOffset));
      if (availableEnd > currentEnd) {
        this.snippet += text.slice(Math.max(0, currentEnd - this.processed), Math.min(text.length, firstEnd + 60 - this.processed));
      }
    }
    this.prefix = (this.prefix + text.slice(0, cut)).slice(-60);
    this.processed += cut;
    this.pending = text.slice(cut);
  }

  result(): TextMatch {
    return {
      count: this.count,
      firstOffset: this.firstOffset,
      firstLength: this.firstLength,
      snippet: this.firstOffset === undefined ? undefined : this.snippet.replace(/[\r\n\t]+/g, ' '),
    };
  }
}
