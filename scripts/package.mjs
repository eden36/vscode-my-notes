// Windows 文件系统不保存 Unix 执行位，打包后修正 VSIX 中搜索程序的权限。
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';

const platforms = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];
const args = process.argv.slice(2);
const targetIndices = args.flatMap((arg, index) => arg === '--target' || arg === '-t' || arg.startsWith('--target=') ? [index] : []);
if (targetIndices.length > 1) { throw new Error('打包目标只能指定一次。'); }
const targetIndex = targetIndices[0] ?? -1;
const target = targetIndex < 0 ? `${process.platform}-${process.arch}` : args[targetIndex].startsWith('--target=') ? args[targetIndex].slice(9) : args[targetIndex + 1];
if (!platforms.includes(target)) { throw new Error(`不支持打包目标：${target ?? '未指定'}。`); }
if (args.some(arg => arg === '--ignoreFile' || arg.startsWith('--ignoreFile='))) { throw new Error('打包脚本不支持自定义忽略文件。'); }
if (targetIndex < 0) { args.push('--target', target); }
// 临时忽略文件仅排除其他平台，不修改开发构建产物。
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'syncnotes-package-'));
let result;
try {
  const ignore = await fs.readFile('.vscodeignore', 'utf8');
  const exclusions = platforms.filter(platform => platform !== target).map(platform => `dist/ripgrep/${platform}/**`);
  const ignoreFile = path.join(temporary, 'vscodeignore');
  await fs.writeFile(ignoreFile, `${ignore}\n${exclusions.join('\n')}\n`);
  const vsce = path.resolve('node_modules', '@vscode', 'vsce', 'vsce');
  result = spawnSync(process.execPath, [vsce, 'package', ...args, '--ignoreFile', ignoreFile], { encoding: 'utf8', windowsHide: true });
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
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
  if (name === `extension/dist/ripgrep/${target}/rg`) {
    bytes[offset + 5] = 3;
    bytes.writeUInt32LE(((0o100755 << 16) | (bytes.readUInt32LE(offset + 38) & 0xffff)) >>> 0, offset + 38);
    updated++;
  }
  offset += 46 + nameLength + extraLength + commentLength;
}
if (updated !== (target.startsWith('win32-') ? 0 : 1)) { throw new Error('VSIX 缺少需要设置权限的搜索程序。'); }
await fs.writeFile(archive, bytes);
if (updated) { console.log('已设置 VSIX 内 Unix 搜索程序的执行权限'); }
