// 仅生成本轮合成数据，记录大量文件及超长单行的搜索耗时和宿主内存。
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { loadSource, testEnvironment } from './test-support.mjs';

const env = await testEnvironment();
try {
  const root = path.join(env.root, 'notes');
  await fs.mkdir(root);
  const block = Buffer.alloc(10240, 120);
  block.write('needle ', 0);
  let index = 0;
  await Promise.all(Array.from({ length: 32 }, async () => {
    while (index < 10000) {
      const current = index++;
      await fs.writeFile(path.join(root, `note-${String(current).padStart(5, '0')}.md`), block);
    }
  }));
  const longFile = await fs.open(path.join(root, 'long.md'), 'w');
  try {
    const longBlock = Buffer.alloc(1024 * 1024, 97);
    for (let i = 0; i < 100; i++) { await longFile.write(longBlock); }
  } finally { await longFile.close(); }
  const { searchNotes } = await loadSource("export { searchNotes } from './src/notes/noteSearch';", env.vscode, {}, { setImmediate });
  const binary = path.resolve('dist', 'ripgrep', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'rg.exe' : 'rg');
  const cfg = { noteExtensions: ['md'], allExtensions: false };
  for (const query of ['needle', 'a', '无匹配']) {
    let first;
    let total = 0;
    let peak = process.memoryUsage.rss();
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, 25);
    const start = performance.now();
    try {
      await searchNotes(env.vscode.Uri.file(root), cfg, query, binary, new AbortController().signal, results => {
        if (results.length && first === undefined) { first = performance.now() - start; }
        total = results.length;
      });
    } finally { clearInterval(timer); }
    console.log(JSON.stringify({ query, files: 10001, bytes: 10000 * block.length + 100 * 1024 * 1024, firstMs: first === undefined ? null : Math.round(first), totalMs: Math.round(performance.now() - start), results: total, hostPeakMiB: Math.round(peak / 1048576) }));
  }
  const controller = new AbortController();
  let cancelledAt = 0;
  const timer = setTimeout(() => { cancelledAt = performance.now(); controller.abort(); }, 500);
  let cancelled = false;
  try {
    await searchNotes(env.vscode.Uri.file(root), cfg, 'a', binary, controller.signal, () => {});
  } catch {
    cancelled = controller.signal.aborted;
  } finally { clearTimeout(timer); }
  if (!cancelled) { throw new Error('性能样本搜索未按预期取消。'); }
  console.log(JSON.stringify({ cancelled: true, cancelMs: Math.round(performance.now() - cancelledAt) }));
} finally {
  await env.cleanup();
}
