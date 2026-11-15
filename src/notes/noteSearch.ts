import { spawn } from 'child_process';
import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { isNoteFile, type NotesConfig } from '../config';
import { literalPattern, TextMatcher, type TextMatch } from './noteSearchText';

export interface NoteSearchResult {
  uri: vscode.Uri;
  relativePath: string;
  nameMatch: boolean;
  count?: number;
  snippet?: string;
  failed?: boolean;
  verified?: boolean;
}

/** 中止搜索时只结束本次启动的进程。 */
function cancelled(signal: AbortSignal): void {
  if (signal.aborted) { throw new vscode.CancellationError(); }
}

/** 按笔记树的隐藏项和扩展名规则枚举，不跟随内部符号链接。 */
async function listFiles(root: string, cfg: NotesConfig, signal: AbortSignal): Promise<{ files: NoteSearchResult[]; incomplete: boolean }> {
  const result: NoteSearchResult[] = [];
  let incomplete = false;
  async function walk(relative: string): Promise<void> {
    cancelled(signal);
    let entries;
    try { entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }); }
    catch {
      if (!relative) { throw new Error('无法读取笔记目录，请检查目录是否存在且可访问。'); }
      incomplete = true;
      return;
    }
    for (const entry of entries) {
      cancelled(signal);
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) { continue; }
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) { await walk(child); }
      else if (entry.isFile() && isNoteFile(entry.name, cfg)) {
        result.push({ uri: vscode.Uri.file(path.join(root, child)), relativePath: child.split(path.sep).join('/'), nameMatch: false });
      }
    }
  }
  await walk('');
  return { files: result, incomplete };
}

/** 搜索当前窗口未保存缓冲区，分块让出事件循环。 */
export async function matchDocument(document: vscode.TextDocument, query: string, signal: AbortSignal): Promise<TextMatch> {
  const version = document.version;
  const matcher = new TextMatcher(query);
  const length = document.offsetAt(document.positionAt(Number.MAX_SAFE_INTEGER));
  for (let offset = 0; offset < length; offset += 65536) {
    cancelled(signal);
    if (document.version !== version) { throw new vscode.CancellationError(); }
    matcher.push(document.getText(new vscode.Range(document.positionAt(offset), document.positionAt(Math.min(length, offset + 65536)))));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  matcher.push('', true);
  return matcher.result();
}

/** 流式校验 UTF-8 并提取首个匹配片段，内存不随长文增长。 */
async function firstSnippet(file: string, query: string, signal: AbortSignal): Promise<string | undefined> {
  const stream = createReadStream(file, { highWaterMark: 65536 });
  const stop = () => stream.destroy();
  signal.addEventListener('abort', stop, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const matcher = new TextMatcher(query);
  let found = false;
  let complete = false;
  try {
    for await (const buffer of stream) {
      cancelled(signal);
      const bytes = buffer as Buffer;
      if (bytes.includes(0)) { throw new Error('二进制文件不支持正文搜索。'); }
      const text = decoder.decode(bytes, { stream: true });
      if (!complete) {
        matcher.push(text);
        if (found) { complete = true; }
        found = matcher.result().firstOffset !== undefined;
      }
    }
    const tail = decoder.decode();
    if (!complete) { matcher.push(tail, true); }
    return matcher.result().snippet;
  } finally {
    signal.removeEventListener('abort', stop);
    stream.destroy();
  }
}

/** 使用 ripgrep 统计磁盘正文并以未保存缓冲区覆盖。 */
export async function searchNotes(
  root: vscode.Uri,
  cfg: NotesConfig,
  query: string,
  executable: string,
  signal: AbortSignal,
  update: (results: NoteSearchResult[], incomplete: boolean) => void,
): Promise<void> {
  const listing = await listFiles(root.fsPath, cfg, signal);
  const files = listing.files;
  let incomplete = listing.incomplete;
  const names = literalPattern(query);
  const byPath = new Map<string, NoteSearchResult>();
  // 保留实际文件名；大小写折叠不能代表文件系统身份，可能合并不同文件。
  const canonicalRoot = await fs.realpath(root.fsPath);
  for (const file of files) {
    names.lastIndex = 0;
    file.nameMatch = names.test(path.basename(file.relativePath));
    byPath.set(path.resolve(canonicalRoot, file.relativePath), file);
  }
  const dirty = new Set<string>();
  for (const document of vscode.workspace.textDocuments) {
    if (!document.isDirty || document.uri.scheme !== 'file') { continue; }
    let fileKey: string;
    try { fileKey = await fs.realpath(document.uri.fsPath); }
    catch { continue; }
    const file = byPath.get(fileKey);
    if (!file) { continue; }
    dirty.add(fileKey);
    const result = await matchDocument(document, query, signal);
    file.count = result.count;
    file.snippet = result.snippet;
    file.verified = true;
  }
  const publish = (incomplete: boolean) => update(files.filter(file => file.nameMatch || (file.count ?? 0) > 0), incomplete);
  publish(incomplete);
  cancelled(signal);
  const args = ['--no-config', '--no-ignore', '--hidden'];
  if (!cfg.allExtensions && cfg.noteExtensions.length && cfg.noteExtensions.every(extension => /^[a-z0-9_-]+$/.test(extension))) {
    for (const extension of cfg.noteExtensions) { args.push('--iglob', `*.${extension}`); }
  }
  args.push('--glob', '!**/.*', '--count-matches', '--null', '--with-filename', '--fixed-strings', '--ignore-case', '-e', query, '.');
  const child = spawn(executable, args, { cwd: root.fsPath, windowsHide: true, shell: false });
  const abort = () => child.kill();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) { abort(); }
  let pending = Buffer.alloc(0);
  let hadDiagnostics = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    child.stderr.on('data', () => { hadDiagnostics = true; });
    child.stdout.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const separator = pending.indexOf(0);
        if (separator < 0) { break; }
        const end = pending.indexOf(10, separator + 1);
        if (end < 0) { break; }
        const fileName = pending.subarray(0, separator).toString('utf8');
        const count = Number(pending.subarray(separator + 1, end).toString('ascii'));
        pending = pending.subarray(end + 1);
        const fileKey = path.resolve(canonicalRoot, fileName);
        const file = byPath.get(fileKey);
        if (file && !dirty.has(fileKey) && Number.isSafeInteger(count) && count > 0) { file.count = count; }
      }
      if (!timer) { timer = setTimeout(() => { timer = undefined; if (!signal.aborted) { publish(incomplete); } }, 100); }
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', () => reject(new Error('无法启动搜索程序，请重新安装扩展。')));
      child.once('close', resolve);
    });
    cancelled(signal);
    // 诊断输出保留整轮不完整提示，单篇失败由异常退出或读取校验决定。
    const scanFailed = exitCode !== 0 && exitCode !== 1;
    incomplete ||= scanFailed || hadDiagnostics;
    if (!scanFailed) {
      for (const file of files) { if (file.count === undefined) { file.count = 0; } }
    } else {
      for (const file of files) { if (file.count === undefined) { file.failed = true; } }
    }
    if (timer) { clearTimeout(timer); timer = undefined; }
    publish(incomplete);
    // ripgrep 无计数也可能是二进制或无效编码，所有候选正文都需流式校验。
    const matching = files.filter(file => !file.verified && !file.failed);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, matching.length) }, async () => {
      while (next < matching.length) {
        const file = matching[next++];
        cancelled(signal);
        try {
          file.snippet = await firstSnippet(file.uri.fsPath, query, signal);
          if (((file.count ?? 0) > 0) !== (file.snippet !== undefined)) { throw new Error('文件内容已变化。'); }
          file.verified = true;
        } catch {
          cancelled(signal);
          file.count = undefined;
          file.failed = true;
          incomplete = true;
        }
        if (!timer) { timer = setTimeout(() => { timer = undefined; if (!signal.aborted) { publish(incomplete); } }, 100); }
      }
    }));
    cancelled(signal);
    if (timer) { clearTimeout(timer); timer = undefined; }
    publish(incomplete);
  } finally {
    if (timer) { clearTimeout(timer); }
    signal.removeEventListener('abort', abort);
  }
}
