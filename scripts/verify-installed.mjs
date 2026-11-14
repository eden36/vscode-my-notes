// VSIX 仅安装到本轮专属扩展目录，再以打包产物执行真实宿主验收。
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { testEnvironment } from './test-support.mjs';
import { vscodeExecutable } from './vscode-executable.mjs';
import { packageArtifact } from './package-artifact.mjs';
const execute = promisify(execFile);
const env = await testEnvironment();
try {
  const { executable, cli } = await vscodeExecutable();
  const extensions = path.join(env.root, 'extensions');
  const userData = path.join(env.root, 'user-data');
  const args = [`--user-data-dir=${userData}`, `--extensions-dir=${extensions}`];
  const cliEnv = {
    ...process.env, ELECTRON_RUN_AS_NODE: '1'
  };
  delete cliEnv.VSCODE_IPC_HOOK_CLI;
  await execute(executable, [cli, ...args, '--install-extension', await packageArtifact(process.argv[2]), '--force'], {
    env: cliEnv, windowsHide: true, timeout: 60000
  });
  const installed = await execute(executable, [cli, ...args, '--list-extensions'], {
    env: cliEnv, windowsHide: true, timeout: 60000
  });
  assert.ok(installed.stdout.includes('saltcoreyan.syncnotes'));
  const directory = (await fs.readdir(extensions)).find(name => name.startsWith('saltcoreyan.syncnotes-'));
  assert.ok(directory);
  const packageRoot = path.join(extensions, directory);
  await execute(process.execPath, ['scripts/verify-host.mjs'], {
    env: {
      ...process.env, SYNCNOTES_HOST_EXTENSION_PATH: packageRoot
    }, windowsHide: true, timeout: 150000,
  });
  console.log('通过 VSIX 隔离安装、扩展注册与打包产物双宿主验收');
}
finally {
  await env.cleanup();
}
