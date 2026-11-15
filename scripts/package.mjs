// Windows 文件系统不保存 Unix 执行位，打包后修正 VSIX 中搜索程序的权限。
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';

const vsce = path.resolve('node_modules', '@vscode', 'vsce', 'vsce');
const result = spawnSync(process.execPath, [vsce, 'package', ...process.argv.slice(2)], { encoding: 'utf8', windowsHide: true });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) { throw result.error; }
if (result.status !== 0) { process.exit(result.status ?? 1); }
const match = result.stdout.match(/Packaged:\s+(.+?\.vsix)\s+\(/);
if (!match) { throw new Error('无法确定生成的 VSIX 路径。'); }
const archive = path.resolve(match[1]);
const bytes = await fs.readFile(archive);
let end = bytes.length - 22;
while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) { end--; }
if (end < Math.max(0, bytes.length - 65557)) { throw new Error('VSIX 中缺少 ZIP 目录。'); }
const count = bytes.readUInt16LE(end + 10);
let offset = bytes.readUInt32LE(end + 16);
let updated = 0;
for (let i = 0; i < count; i++) {
  if (bytes.readUInt32LE(offset) !== 0x02014b50) { throw new Error('VSIX 的 ZIP 目录无效。'); }
  const nameLength = bytes.readUInt16LE(offset + 28);
  const extraLength = bytes.readUInt16LE(offset + 30);
  const commentLength = bytes.readUInt16LE(offset + 32);
  const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
  if (/^extension\/dist\/ripgrep\/(?:darwin|linux)-(?:x64|arm64)\/rg$/.test(name)) {
    bytes[offset + 5] = 3;
    bytes.writeUInt32LE(((0o100755 << 16) | (bytes.readUInt32LE(offset + 38) & 0xffff)) >>> 0, offset + 38);
    updated++;
  }
  offset += 46 + nameLength + extraLength + commentLength;
}
if (updated !== 4) { throw new Error('VSIX 缺少需要设置权限的搜索程序。'); }
await fs.writeFile(archive, bytes);
console.log('已设置 VSIX 内 Unix 搜索程序的执行权限');
