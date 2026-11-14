import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
/** 定位已安装 VS Code 的可执行文件与本地 CLI 入口。 */
export async function vscodeExecutable() {
  const cli = process.env.SYNCNOTES_VSCODE_EXECUTABLE ?? execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['code'], {
    encoding: 'utf8'
  }).trim().split(/\r?\n/)[0];
  const resolved = await fs.realpath(cli);
  let executable = resolved;
  if (process.platform === 'win32' && !cli.endsWith('.exe')) {
    executable = path.join(path.dirname(path.dirname(cli)), 'Code.exe');
  } else if (process.platform === 'linux' && path.basename(path.dirname(resolved)) === 'bin') {
    executable = path.join(path.dirname(path.dirname(resolved)), path.basename(resolved));
  } else if (process.platform === 'darwin' && path.basename(resolved) !== 'Electron') {
    executable = path.resolve(path.dirname(resolved), '../../..', 'MacOS', 'Electron');
  }
  await fs.access(executable);
  const root = path.dirname(executable);
  const candidates = [path.join(root, 'resources', 'app', 'out', 'cli.js'), path.join(root, '..', 'Resources', 'app', 'out', 'cli.js')];
  for (const entry of await fs.readdir(root, {
    withFileTypes: true
  })) {
    if (entry.isDirectory()) {
      candidates.push(path.join(root, entry.name, 'resources', 'app', 'out', 'cli.js'));
    }
  }
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return {
        executable, cli: candidate
      };
    }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) {
        throw error;
      }
    }
  }
  throw new Error('无法定位 VS Code CLI 入口，请通过 SYNCNOTES_VSCODE_EXECUTABLE 指定可执行文件。');
}
