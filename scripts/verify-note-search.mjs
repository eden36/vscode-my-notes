// 使用临时笔记和实际 ripgrep 验证磁盘、缓冲区覆盖及取消。
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { loadSource, testEnvironment } from './test-support.mjs';

const env = await testEnvironment();
try {
  const root = path.join(env.root, 'notes');
  await fs.mkdir(path.join(root, '.hidden'), { recursive: true });
  await fs.writeFile(path.join(root, 'name-foo.md'), '没有命中');
  await fs.writeFile(path.join(root, 'body.md'), '\ufeff😀FOO foo\r\nfoo');
  await fs.writeFile(path.join(root, '.gitignore'), 'body.md\n');
  await fs.writeFile(path.join(root, 'special.md'), 'a.b aXb -word -word');
  await fs.writeFile(path.join(root, 'dirty.md'), 'foo foo');
  await fs.writeFile(path.join(root, 'added.MD'), '原文件没有命中');
  await fs.writeFile(path.join(root, 'upper.MD'), 'foo');
  await fs.writeFile(path.join(root, 'case.md'), 'KKk');
  await fs.writeFile(path.join(root, 'fold.md'), '');
  await fs.writeFile(path.join(root, '.hidden', 'ignored.md'), 'foo');
  await fs.writeFile(path.join(root, 'ignored.js'), 'foo');
  env.vscode.Range = class { constructor(start, end) { this.start = start; this.end = end; } };
  const dirtyDocument = (name, content) => ({
    uri: env.vscode.Uri.file(path.join(root, name)), isDirty: true, version: 1,
    positionAt: offset => Math.min(offset, content.length), offsetAt: position => position,
    getText: range => content.slice(range.start, range.end),
  });
  env.vscode.workspace.textDocuments.push(dirtyDocument('dirty.md', '已经删除'), dirtyDocument('added.MD', '新增 foo foo'), dirtyDocument('fold.md', 'KKk'));
  const { searchNotes, matchDocument } = await loadSource("export { searchNotes, matchDocument } from './src/notes/noteSearch';", env.vscode, {}, { setImmediate });
  const cfg = { noteExtensions: ['md'], allExtensions: false };
  const binary = path.resolve('dist', 'ripgrep', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'rg.exe' : 'rg');
  for (const [query, character] of [['😀', '😀'], ['𐐀', '𐐨']]) {
    const content = `${'x'.repeat(65535)}${character} tail ${character}`;
    const found = await matchDocument(dirtyDocument('boundary.md', content), query, new AbortController().signal);
    assert.equal(found.count, 2);
    assert.equal(found.firstOffset, 65535);
    assert.equal(found.firstLength, 2);
    assert.ok(found.snippet.includes(character));
  }
  console.log('通过 UTF-16 分块边界的 emoji 与非 BMP 大小写匹配验证');

  const linkRoot = path.join(env.root, 'link-scope');
  const outside = path.join(env.root, 'link-target');
  await fs.mkdir(linkRoot);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(linkRoot, 'local.md'), 'junction-needle');
  await fs.writeFile(path.join(outside, 'external-name.md'), 'junction-needle');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(linkRoot, path.join(linkRoot, 'self'), linkType);
  await fs.symlink(outside, path.join(linkRoot, 'external'), linkType);
  const linkController = new AbortController();
  const linkTimeout = setTimeout(() => linkController.abort(), 5000);
  try {
    let linkResults = [];
    let partial;
    await searchNotes(env.vscode.Uri.file(linkRoot), cfg, 'junction-needle', binary, linkController.signal, (next, incomplete) => { linkResults = next; partial = incomplete; });
    assert.deepEqual(Array.from(linkResults, item => item.relativePath), ['local.md']);
    assert.equal(partial, false);
    await searchNotes(env.vscode.Uri.file(linkRoot), cfg, 'external-name', binary, linkController.signal, next => { linkResults = next; });
    assert.equal(linkResults.length, 0, '内部联接目标不能作为名称搜索结果');
    assert.equal(linkController.signal.aborted, false, '自指联接应直接跳过，不能依赖取消结束');
  } finally { clearTimeout(linkTimeout); }
  console.log('通过目录内自指联接和外部联接的范围与终止验证');

  const diagnosticRoot = path.join(env.root, 'diagnostic-scope');
  await fs.mkdir(diagnosticRoot);
  await fs.writeFile(path.join(diagnosticRoot, 'needle-title.md'), 'other content');
  await fs.writeFile(path.join(diagnosticRoot, 'body.md'), 'needle needle');
  for (const scenario of [
    { code: 0, query: 'needle', output: './body.md\0' + '2\n' },
    { code: 1, query: 'title', output: '' },
    { code: 2, query: 'needle', output: './body.md\0' + '2\n' },
    { code: 2, query: 'needle', output: '' },
  ]) {
    const { searchNotes: searchWithDiagnostics } = await loadSource("export { searchNotes } from './src/notes/noteSearch';", env.vscode, {
      child_process: {
        spawn() {
          const child = new EventEmitter();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.kill = () => true;
          setImmediate(() => {
            const bytes = Buffer.from(scenario.output);
            child.stdout.write(bytes.subarray(0, 5));
            child.stdout.end(bytes.subarray(5));
            child.stderr.end('模拟搜索诊断输出');
            child.emit('close', scenario.code);
          });
          return child;
        },
      },
    }, { setImmediate });
    let diagnosticResults = [];
    let partial;
    await searchWithDiagnostics(env.vscode.Uri.file(diagnosticRoot), cfg, scenario.query, binary, new AbortController().signal, (next, incomplete) => { diagnosticResults = next; partial = incomplete; });
    const nameOnly = diagnosticResults.find(item => item.relativePath === 'needle-title.md');
    assert.ok(nameOnly);
    assert.equal(partial, true, '诊断输出仍须提示整轮结果可能不完整');
    if (scenario.code === 2) {
      assert.equal(nameOnly.failed, true, '异常退出时不能把未知次数标成 0');
      assert.equal(nameOnly.count, undefined);
    } else {
      assert.equal(nameOnly.failed, undefined, '成功或无匹配退出不能因诊断输出而误报单篇失败');
      assert.equal(nameOnly.count, 0);
      assert.equal(nameOnly.verified, true);
    }
    if (scenario.output) {
      assert.equal(diagnosticResults.find(item => item.relativePath === 'body.md')?.count, 2, '部分错误不能清除已成功的正文结果');
    }
  }
  console.log('通过诊断输出、无匹配退出及部分失败结果保留验证');

  let results = [];
  await searchNotes(env.vscode.Uri.file(root), cfg, 'foo', binary, new AbortController().signal, next => { results = next; });
  assert.deepEqual(Array.from(results, item => [item.relativePath, item.nameMatch, item.count]).sort(), [
    ['added.MD', false, 2], ['body.md', false, 3], ['name-foo.md', true, 0], ['upper.MD', false, 1],
  ]);
  assert.match(results.find(item => item.relativePath === 'body.md').snippet, /FOO foo/);
  for (const [query, count] of [['a.b', 1], ['-word', 2]]) {
    await searchNotes(env.vscode.Uri.file(root), cfg, query, binary, new AbortController().signal, next => { results = next; });
    assert.equal(results.find(item => item.relativePath === 'special.md')?.count, count);
  }
  await searchNotes(env.vscode.Uri.file(root), cfg, 'k', binary, new AbortController().signal, next => { results = next; });
  assert.equal(results.find(item => item.relativePath === 'case.md')?.count, 3);
  assert.equal(results.find(item => item.relativePath === 'fold.md')?.count, 3);
  const identityRoot = path.join(root, 'identity');
  await fs.mkdir(identityRoot);
  await fs.writeFile(path.join(identityRoot, 'K.md'), 'identity-needle');
  let distinct = true;
  try { await fs.writeFile(path.join(identityRoot, 'K.md'), 'identity-needle identity-needle', { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') { throw error; } distinct = false; }
  if (distinct) {
    await searchNotes(env.vscode.Uri.file(identityRoot), cfg, 'identity-needle', binary, new AbortController().signal, next => { results = next; });
    assert.equal(results.length, 2, '不同 Unicode 路径不能归并为同一篇笔记');
    assert.equal(results.find(item => item.relativePath === 'K.md')?.count, 1);
    assert.equal(results.find(item => item.relativePath === 'K.md')?.count, 2);
    env.vscode.workspace.textDocuments.push(dirtyDocument('identity/K.md', 'identity-needle identity-needle identity-needle'));
    await searchNotes(env.vscode.Uri.file(identityRoot), cfg, 'identity-needle', binary, new AbortController().signal, next => { results = next; });
    assert.equal(results.find(item => item.relativePath === 'K.md')?.count, 3);
    assert.equal(results.find(item => item.relativePath === 'K.md')?.count, 2);
    env.vscode.workspace.textDocuments.pop();
  }
  // 在区分大小写的卷上，ASCII 大小写不同的文件也必须各自保留。
  try {
    await fs.writeFile(path.join(identityRoot, 'k.md'), 'identity-needle identity-needle identity-needle identity-needle', { flag: 'wx' });
    await searchNotes(env.vscode.Uri.file(identityRoot), cfg, 'identity-needle', binary, new AbortController().signal, next => { results = next; });
    assert.equal(results.find(item => item.relativePath === 'K.md')?.count, 1);
    assert.equal(results.find(item => item.relativePath === 'k.md')?.count, 4);
  } catch (error) { if (error.code !== 'EEXIST') { throw error; } }
  const linkedRoot = path.join(env.root, 'notes-link');
  await fs.symlink(root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  env.vscode.workspace.textDocuments.push(dirtyDocument('identity/K.md', 'linked-needle'));
  await searchNotes(env.vscode.Uri.file(path.join(linkedRoot, 'identity')), cfg, 'linked-needle', binary, new AbortController().signal, next => { results = next; });
  assert.equal(results.find(item => item.relativePath === 'K.md')?.count, 1, '根目录联接应识别实际路径打开的未保存文档');
  env.vscode.workspace.textDocuments.pop();
  console.log('通过不同 Unicode 路径、大小写路径与根目录联接验证');

  const encodingRoot = path.join(root, 'encoding');
  await fs.mkdir(encodingRoot);
  for (const allExtensions of [false, true]) {
    for (const bytes of [Buffer.from([255]), Buffer.from('encoding-needle\0tail'), Buffer.concat([Buffer.alloc(65536, 120), Buffer.from([0xe4, 0xb8])])]) {
      await fs.writeFile(path.join(encodingRoot, 'content.md'), bytes);
      let partial;
      await searchNotes(env.vscode.Uri.file(encodingRoot), { ...cfg, allExtensions }, 'encoding-needle', binary, new AbortController().signal, (_next, incomplete) => { partial = incomplete; });
      assert.equal(partial, true, '名称未命中时，二进制和无效 UTF-8 也必须标记搜索不完整');
    }
  }
  await fs.writeFile(path.join(encodingRoot, 'content.md'), '\ufeffencoding-needle\r\nencoding-needle');
  let encodingIncomplete;
  await searchNotes(env.vscode.Uri.file(encodingRoot), cfg, 'encoding-needle', binary, new AbortController().signal, (next, incomplete) => { results = next; encodingIncomplete = incomplete; });
  assert.equal(results[0]?.count, 2);
  assert.equal(encodingIncomplete, false);
  await fs.writeFile(path.join(encodingRoot, 'content.md'), Buffer.from([255]));
  env.vscode.workspace.textDocuments.push(dirtyDocument('encoding/content.md', 'buffer-needle'));
  await searchNotes(env.vscode.Uri.file(encodingRoot), cfg, 'buffer-needle', binary, new AbortController().signal, (next, incomplete) => { results = next; encodingIncomplete = incomplete; });
  assert.equal(results[0]?.count, 1);
  assert.equal(encodingIncomplete, false, '未保存缓冲区应覆盖磁盘中的无效编码');
  env.vscode.workspace.textDocuments.pop();
  console.log('通过无名称命中时的二进制、无效编码与缓冲区覆盖验证');
  await fs.writeFile(path.join(root, 'foo-binary.md'), Buffer.from([102, 111, 111, 0, 1]));
  await fs.writeFile(path.join(root, 'foo-invalid.md'), Buffer.from([102, 111, 111, 32, 255]));
  let incomplete = false;
  await searchNotes(env.vscode.Uri.file(root), cfg, 'foo', binary, new AbortController().signal, (next, partial) => { results = next; incomplete = partial; });
  assert.equal(results.find(item => item.relativePath === 'foo-binary.md')?.failed, true);
  assert.equal(results.find(item => item.relativePath === 'foo-invalid.md')?.failed, true);
  assert.equal(incomplete, true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchNotes(env.vscode.Uri.file(root), cfg, 'foo', binary, controller.signal, () => {}));
  await assert.rejects(searchNotes(env.vscode.Uri.file(root), cfg, 'foo', path.join(root, 'missing-rg'), new AbortController().signal, () => {}));
  await Promise.all(Array.from({ length: 501 }, (_, index) => fs.writeFile(path.join(root, `unique-keyword-${index}.md`), '')));
  env.settings.set('notesLocation', root);
  env.settings.set('noteExtensions', ['md']);
  const listeners = { value: [], accept: [], hide: [] };
  const subscribe = type => callback => { listeners[type].push(callback); return { dispose() {} }; };
  const picker = {
    value: '', items: [], selectedItems: [], busy: false,
    onDidChangeValue: subscribe('value'), onDidAccept: subscribe('accept'), onDidHide: subscribe('hide'),
    show() {}, hide() { for (const listener of listeners.hide) { listener(); } }, dispose() {},
  };
  let created = 0;
  env.vscode.window.createQuickPick = () => { created++; return picker; };
  env.vscode.QuickPickItemKind = { Separator: -1 };
  env.vscode.workspace.createFileSystemWatcher = () => ({
    onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {},
  });
  const { NoteSearchPicker } = await loadSource("export { NoteSearchPicker } from './src/notes/noteSearchPicker';", env.vscode, {}, { setImmediate });
  const search = new NoteSearchPicker(process.cwd());
  search.show();
  search.show();
  assert.equal(created, 1);
  picker.value = 'unique-keyword';
  for (const listener of listeners.value) { listener(picker.value); }
  const deadline = Date.now() + 10000;
  while ((picker.busy || !picker.title?.includes('501 篇')) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.ok(picker.title.includes('501 篇'));
  const more = picker.items.find(item => item.more);
  assert.ok(more, '超过 500 项时应提供加载更多');
  picker.selectedItems = [more];
  for (const listener of listeners.accept) { listener(); }
  assert.equal(picker.items.filter(item => item.result).length, 501);
  await search.shutdown();
  console.log('通过真实进程搜索、名称与正文合并、未保存覆盖、过滤和错误验证');
} finally {
  await env.cleanup();
}
