// 通过真实激活入口验证命令、笔记操作、设置协议与协调器关闭。
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { loadSource, testEnvironment } from './test-support.mjs';
const env = await testEnvironment();
let api;
try {
  const notes = path.join(env.root, 'notes');
  await fs.mkdir(notes);
  await fs.writeFile(path.join(notes, '已有笔记.md'), '原有内容');
  env.settings.set('notesLocation', notes);
  env.settings.set('notesLocation', 'relative/invalid');
  env.settings.set('sync.focusCooldownSeconds', -1);
  env.settings.set('sync.onStartup', false);
  api = await loadSource("export { activate, deactivate } from './src/extension'; export { getSyncConfig } from './src/config'; export { secretKeyFor } from './src/sync/secrets';", env.vscode);
  api.activate(env.context);
  await env.flush();
  const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
  for (const command of packageJson.contributes.commands) {
    assert.ok(env.commands.has(command.command), command.command);
  }
  await env.commands.get('syncnotes.openSettings')();
  const repairPanel = env.panels[0];
  await repairPanel.receive({ type: 'ready', requestId: 100 });
  assert.equal(repairPanel.posted.at(-1).issues.length, 2);
  await repairPanel.receive({ type: 'testConnection', requestId: 101, provider: 'git' });
  assert.equal(repairPanel.posted.at(-1).type, 'error');
  await repairPanel.receive({ type: 'update', requestId: 102, key: 'notesLocation', value: notes });
  await repairPanel.receive({ type: 'update', requestId: 103, key: 'sync.focusCooldownSeconds', value: 300 });
  await env.flush();
  assert.equal(repairPanel.posted.at(-1).issues.length, 0);
  console.log('通过 非法手工配置下激活、设置加载与修复');
  assert.equal((await env.trees[0].getChildren()).length, 1);
  console.log('通过 真实激活入口、命令注册与笔记树');
  env.inputs.push('新笔记');
  await env.commands.get('syncnotes.newNote')();
  assert.equal(await fs.readFile(path.join(notes, '新笔记.md'), 'utf8'), '');
  let note = (await env.trees[0].getChildren()).find(item => item.name === '新笔记.md');
  env.inputs.push('改名');
  await env.commands.get('syncnotes.renameNote')(note);
  assert.equal(await fs.readFile(path.join(notes, '改名.md'), 'utf8'), '');
  note = (await env.trees[0].getChildren()).find(item => item.name === '改名.md');
  env.choices.push('删除');
  await env.commands.get('syncnotes.deleteNote')(note);
  await assert.rejects(fs.stat(path.join(notes, '改名.md')));
  assert.equal(await fs.readFile(path.join(notes, '已有笔记.md'), 'utf8'), '原有内容');
  console.log('通过 新建、重命名与删除入口');
  await env.commands.get('syncnotes.openSettings')();
  const panel = env.panels[0];
  await env.commands.get('syncnotes.openSettings')();
  assert.equal(env.panels.length, 1);
  assert.ok(panel.webview.html.includes('dist/settings.js'));
  assert.ok(panel.webview.html.includes('dist/settings.css'));
  await panel.receive({
    type: 'ready', requestId: 1
  });
  assert.equal(panel.posted.at(-1).type, 'state');
  await panel.receive({
    type: 'update', requestId: 2, key: 'sync.onSave', value: true
  });
  await env.flush();
  assert.equal(env.settings.get('sync.onSave'), true);
  await panel.receive({
    type: 'update', requestId: 3, key: 'arbitrary.setting', value: 'invalid'
  });
  assert.equal(panel.posted.at(-1).type, 'error');
  assert.equal(env.settings.has('arbitrary.setting'), false);
  await panel.receive({
    type: 'update', requestId: 4, key: 'sync.onSaveDebounceSeconds', value: -1
  });
  assert.equal(panel.posted.at(-1).type, 'error');
  console.log('通过 外部资源、单例设置页与消息校验');
  env.settings.set('sync.webdav.url', 'https://example.invalid/dav');
  env.settings.set('sync.webdav.username', 'user-A');
  const targetConfig = api.getSyncConfig();
  await panel.receive({
    type: 'saveCredential', requestId: 5, provider: 'webdav', value: 'test-fixture-password',
    target: {
      url: targetConfig.webdav.url, username: 'user-A'
    }
  });
  assert.equal(env.secrets.get(api.secretKeyFor('webdav', targetConfig)), 'test-fixture-password');
  env.settings.set('sync.webdav.username', 'user-B');
  assert.equal(env.secrets.has(api.secretKeyFor('webdav', api.getSyncConfig())), false);
  assert.equal(panel.posted.some(message => JSON.stringify(message).includes('test-fixture-password')), false);
  await panel.receive({
    type: 'testConnection', requestId: 6, provider: 'git'
  });
  const result = panel.posted.findLast(message => message.type === 'result');
  assert.equal(result.requestId, 6);
  assert.equal(result.ok, false);
  console.log('通过 凭据账号隔离、目标绑定与连接结果归属');
  await panel.receive({ type: 'update', requestId: 7, key: 'sync.provider', value: 'git' });
  await env.flush();
  assert.ok(env.statusBars[0].text.includes('笔记同步'));
  await panel.receive({ type: 'update', requestId: 8, key: 'sync.provider', value: 'none' });
  await env.flush();
  console.log('通过 启用同步后的状态栏入口');
  await env.commands.get('syncnotes.sync')();
  assert.ok(env.messages.some(message => message.includes('尚未启用同步')));
  assert.equal(env.errors.length, 0);
  console.log('通过 未配置同步提示与异步事件');
  const elements = new Map();
  const sent = [];
  let onMessage;
  const element = id => {
    if (!elements.has(id)) {
      const listeners = new Map();
      elements.set(id, { value: '', style: {}, listeners, classList: { toggle() {} },
        addEventListener(type, listener) { listeners.set(type, listener); },
        setCustomValidity(value) { this.validityMessage = value; }, reportValidity() {}, querySelector() { return {}; } });
    }
    return elements.get(id);
  };
  await loadSource("import './src/settings/webview/settings';", env.vscode, {}, {
    document: { getElementById: element }, window: { addEventListener(_type, listener) { onMessage = listener; } },
    acquireVsCodeApi: () => ({ postMessage(message) { sent.push(message); } })
  });
  element('gitTestBtn').listeners.get('click')();
  assert.equal(element('gitTestBtn').disabled, true);
  onMessage({ data: { type: 'error', requestId: sent.at(-1).requestId, message: '参数错误' } });
  assert.equal(element('gitTestBtn').disabled, false);
  assert.equal(element('gitTestBtn').textContent, '测试连接');
  console.log('通过 设置页连接测试错误后恢复按钮');
  panel.dispose();
  const createPanel = env.vscode.window.createWebviewPanel;
  env.vscode.window.createWebviewPanel = (...args) => {
    const stalled = createPanel(...args);
    stalled.receive = async () => {};
    return stalled;
  };
  await assert.rejects(env.commands.get('syncnotes.openSettings')(), /设置页加载超时/);
  env.vscode.window.createWebviewPanel = createPanel;
  await env.commands.get('syncnotes.openSettings')();
  assert.equal(env.panels.length, 3);
  console.log('通过 设置页加载超时后重新创建');
}
finally {
  await api?.deactivate();
  for (const disposable of [...env.context.subscriptions].reverse()) {
    await disposable.dispose();
  }
  for (const panel of env.panels) {
    panel.dispose();
  }
  await env.cleanup();
}
