// 独立 VS Code 用户数据目录验收实际宿主与跨窗口编辑状态。
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { testEnvironment } from './test-support.mjs';
import { vscodeExecutable } from './vscode-executable.mjs';
const env = await testEnvironment();
const children = [];
try {
  const repo = process.cwd();
  const { executable } = await vscodeExecutable();
  const notes = path.join(env.root, 'notes');
  await fs.mkdir(notes);
  await fs.writeFile(path.join(notes, 'a.md'), '宿主测试笔记\n');
  const results = await Promise.all(['editor', 'observer'].map(async (role) => {
    const userData = path.join(env.root, role, 'user-data');
    await fs.mkdir(path.join(userData, 'User'), {
      recursive: true
    });
    await fs.writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({
      'mynotes.notesLocation': notes, 'mynotes.sync.provider': 'none', 'mynotes.sync.onStartup': false,
      'telemetry.telemetryLevel': 'off', 'security.workspace.trust.enabled': false,
      'chat.disableAIFeatures': true, 'workbench.startupEditor': 'none',
    }));
    const processEnv = {
      ...process.env, MYNOTES_HOST_TEST_ROOT: env.root, MYNOTES_HOST_TEST_ROLE: role
    };
    delete processEnv.ELECTRON_RUN_AS_NODE;
    delete processEnv.VSCODE_IPC_HOOK_CLI;
    const child = spawn(executable, [`--extensionDevelopmentPath=${process.env.MYNOTES_HOST_EXTENSION_PATH ?? repo}`, `--extensionTestsPath=${path.join(repo, 'out/test/host')}`,
    `--user-data-dir=${userData}`, `--extensions-dir=${path.join(env.root, 'extensions')}`,
      '--disable-extensions', '--disable-gpu', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window', notes], {
      env: processEnv, windowsHide: true, stdio: 'pipe'
    });
    children.push(child);
    let output = '';
    child.stdout.on('data', chunk => {
      output = (output + chunk).slice(-8000);
    });
    child.stderr.on('data', chunk => {
      output = (output + chunk).slice(-8000);
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${role} 宿主测试超时。\n${output}`)), 120000);
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', code => {
        clearTimeout(timer);
        code === 0 ? resolve({
          role, code
        }) : reject(new Error(`${role} 宿主失败 ${code}\n${output}`));
      });
    });
  }));
  assert.equal(results.length, 2);
  for (const role of ['editor', 'observer']) {
    const result = JSON.parse(await fs.readFile(path.join(env.root, `${role}-passed.json`), 'utf8'));
    assert.ok(result.activation && result.tree && result.settings && result.editing);
  }
  console.log('通过 两个真实 VS Code 宿主的激活、设置页、笔记树和跨窗口编辑保护');
}
finally {
  for (const child of children) {
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') {
        await new Promise(resolve => {
          const terminate = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true, stdio: 'ignore'
          });
          terminate.once('exit', resolve);
          terminate.once('error', resolve);
        });
      }
      else {
        child.kill();
      }
    }
  }
  await env.cleanup();
}
