import * as vscode from 'vscode';
import { getNotesConfig, getSyncConfig, updateConfig } from '../config';
import { log } from '../log';
import { GitSyncProvider } from '../sync/git/gitSyncProvider';
import { deleteSecretFor, getSecretFor, setSecretFor, type CredentialProvider } from '../sync/secrets';
import { WebdavSyncProvider } from '../sync/webdav/webdavSyncProvider';

/** webview → 扩展宿主 */
type InboundMessage =
  | { type: 'ready' }
  | { type: 'update'; key: string; value: unknown }
  | { type: 'browseNotesLocation' }
  | { type: 'saveCredential'; provider: CredentialProvider; value: string }
  | { type: 'clearCredential'; provider: CredentialProvider }
  | { type: 'testConnection'; provider: CredentialProvider }
  | { type: 'sync' }
  | { type: 'openAdvancedSettings' };

/** 内联反馈落在哪一块区域 */
type ResultTarget = 'git' | 'webdav';

/**
 * 以编辑器页签形式展示的设置面板，覆盖笔记与两种同步后端的全部常用配置。
 *
 * Git 与 WebDAV 两节跟随「同步方式」下拉框切换显示。凭据与连通性测试都在
 * 页内完成，不必再跳去命令面板或额外的配置向导；本地仓库由首次同步自动建立。
 *
 * 单例：重复调用 show() 只会把已打开的页签带到前台，不会开出多个页签。
 */
export class SettingsPanel {
  private static current: SettingsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  static show(context: vscode.ExtensionContext): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'mynotes.settings',
      'MyNotes 设置',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    SettingsPanel.current = new SettingsPanel(context, panel);
  }

  /** 配置在别处（settings.json、其他窗口）发生变化时，若面板正开着就刷新显示 */
  static refreshIfOpen(): void {
    SettingsPanel.current?.refresh();
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
  ) {
    this.panel = panel;
    panel.webview.html = this.renderHtml(panel.webview);

    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: InboundMessage) => this.handleMessage(message)),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private refresh(): void {
    void this.postState();
  }

  private dispose(): void {
    this.disposed = true;
    if (SettingsPanel.current === this) {
      SettingsPanel.current = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.postState();
        return;

      case 'update':
        try {
          await updateConfig(message.key, message.value);
        } catch (err) {
          log.error(`更新设置失败：${message.key}`, err);
        }
        await this.postState();
        return;

      case 'browseNotesLocation': {
        const picked = await vscode.window.showOpenDialog({
          title: '选择笔记目录',
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: '设为笔记目录',
        });
        if (picked?.length) {
          await updateConfig('notesLocation', picked[0].fsPath);
        }
        await this.postState();
        return;
      }

      case 'saveCredential': {
        if (!message.value) {
          this.postResult(message.provider, false, '请先输入内容再保存。');
          return;
        }
        const saved = await setSecretFor(this.context, message.provider, message.value);
        this.postResult(
          message.provider,
          saved,
          saved ? '凭据已保存到系统密钥库。' : '请先填写上方的地址，凭据需要与地址绑定保存。',
        );
        await this.postState();
        return;
      }

      case 'clearCredential': {
        const cleared = await deleteSecretFor(this.context, message.provider);
        this.postResult(message.provider, cleared, cleared ? '凭据已清除。' : '当前地址没有对应的凭据。');
        await this.postState();
        return;
      }

      case 'testConnection':
        await this.testConnection(message.provider);
        return;

      case 'sync':
        await vscode.commands.executeCommand('mynotes.sync');
        return;

      case 'openAdvancedSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:qunmei.mynotes');
        return;
    }
  }

  private async testConnection(provider: CredentialProvider): Promise<void> {
    const backend =
      provider === 'git' ? new GitSyncProvider(this.context) : new WebdavSyncProvider(this.context);
    try {
      this.postResult(provider, true, await backend.testConnection());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`测试 ${provider} 连接失败：${message}`);
      this.postResult(provider, false, message);
    }
  }

  private postResult(target: ResultTarget, ok: boolean, message: string): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage({ type: 'result', target, ok, message });
    }
  }

  private async postState(): Promise<void> {
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage({
      type: 'state',
      notes: getNotesConfig(),
      sync: getSyncConfig(),
      // 只回传「是否已设置」，密文本身绝不回到 webview
      credentials: {
        git: Boolean(await getSecretFor(this.context, 'git')),
        webdav: Boolean(await getSecretFor(this.context, 'webdav')),
      },
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>${STYLE}</style>
</head>
<body>
${BODY}
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
  }
}

function createNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

const STYLE = `
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
  }
  .page { max-width: 680px; margin: 0 auto; padding: 28px 32px 60px; }
  .page-header {
    display: flex; align-items: baseline; justify-content: space-between; gap: 16px;
    margin-bottom: 4px;
  }
  .page-header h1 { font-size: 20px; font-weight: 600; margin: 0; }
  .page-header a { font-size: 12px; color: var(--vscode-textLink-foreground); cursor: pointer; white-space: nowrap; }
  .page-header a:hover { color: var(--vscode-textLink-activeForeground); }
  .page-subtitle { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 0 0 28px; }

  section { margin-bottom: 34px; }
  h2 {
    display: flex; align-items: center; gap: 10px;
    font-size: 13px; font-weight: 600; margin: 0 0 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
  }
  /* 用 !important 保证覆盖元素自身的 display，切换后端时可靠地整节隐藏 */
  .hidden { display: none !important; }

  .field { margin-bottom: 18px; }
  .field:last-child { margin-bottom: 0; }
  label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
  .hint { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 6px 0 0; line-height: 1.5; }
  .local-only-badge {
    display: inline-block;
    font-size: 11px; font-weight: 600;
    padding: 0 6px; border-radius: 3px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    margin-right: 6px;
    vertical-align: 1px;
  }

  input[type="text"], input[type="password"], input[type="number"], select {
    width: 100%; box-sizing: border-box;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
    border-radius: 3px; padding: 7px 10px; font-size: 13px; font-family: inherit;
  }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  input[type="number"] { width: 110px; }
  select { max-width: 320px; }

  .row { display: flex; align-items: center; gap: 8px; }
  .row input { flex: 1; }
  .checkbox-field { display: flex; align-items: center; gap: 8px; }
  .checkbox-field label { margin: 0; font-weight: normal; }
  .inline-number { display: flex; align-items: center; gap: 8px; margin-top: 8px; margin-left: 24px; }
  .inline-number label { margin: 0; font-size: 12px; font-weight: normal; color: var(--vscode-descriptionForeground); }

  button {
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: none; border-radius: 3px; padding: 6px 14px;
    font-size: 13px; font-family: inherit; cursor: pointer; white-space: nowrap;
  }
  button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.3)); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }

  .credential-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); margin: 8px 0 0; }
  .credential-status .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
  .credential-status.set .dot { background: var(--vscode-charts-green, #3fb950); }

  .result { font-size: 12px; margin: 10px 0 0; line-height: 1.5; }
  .result:empty { display: none; }
  .result.ok { color: var(--vscode-charts-green, #3fb950); }
  .result.err { color: var(--vscode-errorForeground, #f14c4c); }
`;

const BODY = `
<div class="page">
  <div class="page-header">
    <h1>MyNotes 设置</h1>
    <a id="advancedLink">在设置编辑器中打开全部原始配置项</a>
  </div>
  <p class="page-subtitle">
    改动的字段会立即生效，无需单独保存。凭据保存在系统密钥库中，不会写入设置文件。<br />
    所有设置都会在同一台电脑的多个 VS Code Profile 间共享一份；除标注「不跨设备」的字段外，
    还会在你开启 VS Code 内置的设置同步（Settings Sync）后一并带到其他电脑上；
    <strong>凭据本身不受设置同步影响，换新电脑仍需重新录入</strong>。
  </p>

  <section>
    <h2>笔记</h2>
    <div class="field">
      <label for="notesLocation">笔记目录</label>
      <div class="row">
        <input type="text" id="notesLocation" placeholder="尚未设置" />
        <button id="browseBtn">浏览…</button>
      </div>
      <p class="hint">
        <span class="local-only-badge">不跨设备</span>
        这一项在本机各 Profile 间共享，换 Profile 无需重设；但不同电脑的盘符、目录结构通常不同，
        因此不参与设置同步，需要在每台设备上分别设置一次。
      </p>
    </div>
    <div class="field">
      <label for="defaultNoteExtension">新建笔记默认扩展名</label>
      <input type="text" id="defaultNoteExtension" />
    </div>
    <div class="field">
      <label for="noteExtensions">显示的扩展名（逗号分隔，填 * 显示全部文件）</label>
      <input type="text" id="noteExtensions" />
    </div>
  </section>

  <section>
    <h2>同步</h2>
    <div class="field">
      <div class="checkbox-field">
        <input type="checkbox" id="onStartup" />
        <label for="onStartup">启动时自动同步</label>
      </div>
      <div class="checkbox-field">
        <input type="checkbox" id="onWindowFocus" />
        <label for="onWindowFocus">窗口聚焦时自动同步</label>
      </div>
      <div class="inline-number">
        <label for="focusCooldownSeconds">冷却时间（秒）</label>
        <input type="number" id="focusCooldownSeconds" min="10" />
      </div>
      <div class="checkbox-field">
        <input type="checkbox" id="onSave" />
        <label for="onSave">保存笔记后自动同步</label>
      </div>
      <div class="inline-number">
        <label for="onSaveDebounceSeconds">防抖时长（秒）</label>
        <input type="number" id="onSaveDebounceSeconds" min="1" />
      </div>
    </div>

    <div class="field">
      <label for="deviceName">设备名称（留空取主机名）</label>
      <input type="text" id="deviceName" />
      <p class="hint">
        <span class="local-only-badge">不跨设备</span>
        用于提交信息与冲突文件命名，便于分辨改动来自哪台设备；这一项在本机各 Profile 间共享，
        但不参与设置同步，理应因设备而异。
      </p>
    </div>

    <div class="field">
      <label for="provider">同步方式</label>
      <div class="row">
        <select id="provider">
          <option value="none">不同步</option>
          <option value="git">Git 仓库</option>
          <option value="webdav">WebDAV</option>
        </select>
        <button id="syncNowBtn" class="primary">立即同步</button>
      </div>
      <p class="hint" id="noProviderHint">选择一种同步方式后，下方会出现对应的参数设置。切换方式不会清空另一种的配置，可以随时切回来。</p>
    </div>
  </section>

  <section id="gitSection" class="hidden">
    <h2>Git 仓库</h2>
    <div class="field">
      <label for="gitRemoteUrl">远程仓库地址</label>
      <input type="text" id="gitRemoteUrl" placeholder="https://github.com/用户名/notes.git" />
      <p class="hint">HTTPS 地址需在下方录入访问令牌；git@ 开头的 SSH 地址使用本机已配置的 SSH key，无需令牌。</p>
    </div>
    <div class="field">
      <label for="gitBranch">同步分支</label>
      <input type="text" id="gitBranch" />
    </div>
    <div class="field">
      <label for="gitToken">访问令牌</label>
      <div class="row">
        <input type="password" id="gitToken" autocomplete="off" placeholder="粘贴个人访问令牌后点击保存" />
        <button id="gitSaveTokenBtn">保存</button>
        <button id="gitClearTokenBtn">清除</button>
      </div>
      <p class="credential-status" id="gitCredentialStatus"><span class="dot"></span><span class="text"></span></p>
    </div>
    <div class="field">
      <label for="gitCommitMessageTemplate">提交信息模板</label>
      <input type="text" id="gitCommitMessageTemplate" />
      <p class="hint">可用占位符：{device}、{datetime}、{count}</p>
    </div>
    <div class="field">
      <label for="gitUserName">user.name（留空沿用全局配置）</label>
      <input type="text" id="gitUserName" />
    </div>
    <div class="field">
      <label for="gitUserEmail">user.email（留空沿用全局配置）</label>
      <input type="text" id="gitUserEmail" />
    </div>
    <div class="field">
      <div class="actions">
        <button id="gitTestBtn">测试连接</button>
      </div>
      <p class="result" id="gitResult"></p>
      <p class="hint">笔记目录还不是 Git 仓库时，首次同步会自动执行 git init、设置 origin 与分支，并写入一份 .gitignore，无需手动初始化。</p>
    </div>
  </section>

  <section id="webdavSection" class="hidden">
    <h2>WebDAV</h2>
    <div class="field">
      <label for="webdavUrl">服务地址</label>
      <input type="text" id="webdavUrl" placeholder="https://dav.jianguoyun.com/dav/" />
    </div>
    <div class="field">
      <label for="webdavRemotePath">远端路径</label>
      <input type="text" id="webdavRemotePath" />
    </div>
    <div class="field">
      <label for="webdavUsername">用户名</label>
      <input type="text" id="webdavUsername" />
    </div>
    <div class="field">
      <label for="webdavPassword">密码</label>
      <div class="row">
        <input type="password" id="webdavPassword" autocomplete="off" placeholder="输入密码后点击保存" />
        <button id="webdavSaveTokenBtn">保存</button>
        <button id="webdavClearTokenBtn">清除</button>
      </div>
      <p class="credential-status" id="webdavCredentialStatus"><span class="dot"></span><span class="text"></span></p>
      <p class="hint">坚果云等服务需使用「应用密码」而非登录密码。</p>
    </div>
    <div class="field">
      <div class="actions">
        <button id="webdavTestBtn">测试连接</button>
      </div>
      <p class="result" id="webdavResult"></p>
    </div>
  </section>
</div>
`;

/**
 * 每个字段改动即时写回配置，不设单独的保存按钮——
 * 与 VS Code 内置设置页的交互习惯保持一致。凭据是例外：
 * 明确点「保存」才提交，避免边输入边写入密钥库。
 */
const SCRIPT = `
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  function bindText(id, key, transform) {
    const el = $(id);
    el.addEventListener('change', () => {
      vscode.postMessage({ type: 'update', key, value: transform ? transform(el.value) : el.value });
    });
  }
  function bindCheckbox(id, key) {
    const el = $(id);
    el.addEventListener('change', () => vscode.postMessage({ type: 'update', key, value: el.checked }));
  }
  function bindNumber(id, key) {
    const el = $(id);
    el.addEventListener('change', () => {
      const n = Number(el.value);
      if (Number.isFinite(n)) vscode.postMessage({ type: 'update', key, value: n });
    });
  }

  bindText('notesLocation', 'notesLocation');
  bindText('defaultNoteExtension', 'defaultNoteExtension');
  bindText('noteExtensions', 'noteExtensions', (v) =>
    v.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  );
  bindText('provider', 'sync.provider');
  bindCheckbox('onStartup', 'sync.onStartup');
  bindCheckbox('onWindowFocus', 'sync.onWindowFocus');
  bindNumber('focusCooldownSeconds', 'sync.focusCooldownSeconds');
  bindCheckbox('onSave', 'sync.onSave');
  bindNumber('onSaveDebounceSeconds', 'sync.onSaveDebounceSeconds');
  bindText('deviceName', 'sync.deviceName');
  bindText('gitRemoteUrl', 'sync.git.remoteUrl');
  bindText('gitBranch', 'sync.git.branch');
  bindText('gitCommitMessageTemplate', 'sync.git.commitMessageTemplate');
  bindText('gitUserName', 'sync.git.userName');
  bindText('gitUserEmail', 'sync.git.userEmail');
  bindText('webdavUrl', 'sync.webdav.url');
  bindText('webdavRemotePath', 'sync.webdav.remotePath');
  bindText('webdavUsername', 'sync.webdav.username');

  $('browseBtn').addEventListener('click', () => vscode.postMessage({ type: 'browseNotesLocation' }));
  $('syncNowBtn').addEventListener('click', () => vscode.postMessage({ type: 'sync' }));
  $('advancedLink').addEventListener('click', () => vscode.postMessage({ type: 'openAdvancedSettings' }));

  function bindCredential(provider, inputId, saveId, clearId) {
    $(saveId).addEventListener('click', () => {
      const input = $(inputId);
      vscode.postMessage({ type: 'saveCredential', provider, value: input.value });
      input.value = '';
    });
    $(clearId).addEventListener('click', () => {
      $(inputId).value = '';
      vscode.postMessage({ type: 'clearCredential', provider });
    });
  }
  bindCredential('git', 'gitToken', 'gitSaveTokenBtn', 'gitClearTokenBtn');
  bindCredential('webdav', 'webdavPassword', 'webdavSaveTokenBtn', 'webdavClearTokenBtn');

  function bindTest(provider, buttonId) {
    $(buttonId).addEventListener('click', () => {
      const btn = $(buttonId);
      btn.disabled = true;
      btn.textContent = '测试中…';
      showResult(provider, null, '正在连接…');
      vscode.postMessage({ type: 'testConnection', provider });
    });
  }
  bindTest('git', 'gitTestBtn');
  bindTest('webdav', 'webdavTestBtn');

  const RESULT_ELEMENTS = { git: 'gitResult', webdav: 'webdavResult' };
  const BUSY_BUTTONS = { git: ['gitTestBtn', '测试连接'], webdav: ['webdavTestBtn', '测试连接'] };

  function showResult(target, ok, message) {
    const el = $(RESULT_ELEMENTS[target]);
    el.textContent = message;
    el.classList.toggle('ok', ok === true);
    el.classList.toggle('err', ok === false);
  }

  // 焦点中的字段不被自动刷新覆盖，避免打断正在输入的内容
  function setIfNotFocused(el, value) {
    if (document.activeElement !== el) el.value = value;
  }

  window.addEventListener('message', (event) => {
    const message = event.data;

    if (message.type === 'result') {
      showResult(message.target, message.ok, message.message);
      const [buttonId, label] = BUSY_BUTTONS[message.target];
      const btn = $(buttonId);
      btn.disabled = false;
      btn.textContent = label;
      return;
    }

    if (message.type !== 'state') return;
    const { notes, sync, credentials } = message;

    setIfNotFocused($('notesLocation'), notes.notesLocation);
    setIfNotFocused($('defaultNoteExtension'), notes.defaultNoteExtension);
    setIfNotFocused($('noteExtensions'), notes.allExtensions ? '*' : notes.noteExtensions.join(', '));

    $('provider').value = sync.provider;
    $('onStartup').checked = sync.onStartup;
    $('onWindowFocus').checked = sync.onWindowFocus;
    setIfNotFocused($('focusCooldownSeconds'), sync.focusCooldownSeconds);
    $('onSave').checked = sync.onSave;
    setIfNotFocused($('onSaveDebounceSeconds'), sync.onSaveDebounceSeconds);
    setIfNotFocused($('deviceName'), sync.deviceName);

    setIfNotFocused($('gitRemoteUrl'), sync.git.remoteUrl);
    setIfNotFocused($('gitBranch'), sync.git.branch);
    setIfNotFocused($('gitCommitMessageTemplate'), sync.git.commitMessageTemplate);
    setIfNotFocused($('gitUserName'), sync.git.userName);
    setIfNotFocused($('gitUserEmail'), sync.git.userEmail);

    setIfNotFocused($('webdavUrl'), sync.webdav.url);
    setIfNotFocused($('webdavRemotePath'), sync.webdav.remotePath);
    setIfNotFocused($('webdavUsername'), sync.webdav.username);

    // 只展示当前选中后端的参数，避免两套配置同时铺在页面上
    $('gitSection').classList.toggle('hidden', sync.provider !== 'git');
    $('webdavSection').classList.toggle('hidden', sync.provider !== 'webdav');
    $('noProviderHint').classList.toggle('hidden', sync.provider !== 'none');
    $('syncNowBtn').style.display = sync.provider === 'none' ? 'none' : '';

    for (const [provider, id] of [['git', 'gitCredentialStatus'], ['webdav', 'webdavCredentialStatus']]) {
      const el = $(id);
      const has = credentials[provider];
      el.classList.toggle('set', has);
      el.querySelector('.text').textContent = has ? '已保存凭据' : '尚未保存凭据';
    }
  });

  vscode.postMessage({ type: 'ready' });
`;
