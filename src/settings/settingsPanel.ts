import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { getNotesConfig, getSyncConfig, updateConfig, type ConfigurationIssue } from '../config';
import { log } from '../log';
import { GitSyncProvider } from '../sync/git/gitSyncProvider';
import { deleteSecretFor, getSecretFor, setSecretFor, type CredentialProvider } from '../sync/secrets';
import { WebdavSyncProvider } from '../sync/webdav/webdavSyncProvider';
import { parseInbound, type InboundMessage } from './protocol';

/** webview → 扩展宿主 */
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
  private version = 0;
  private activeRequestId = 0;
  private queue: Promise<void> = Promise.resolve();
  private resolveReady: (() => void) | undefined;
  private readonly ready = new Promise<void>(resolve => { this.resolveReady = resolve; });

  static show(context: vscode.ExtensionContext): Promise<void> {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      return SettingsPanel.current.waitForReady();
    }
    const panel = vscode.window.createWebviewPanel(
      'mynotes.settings',
      'MyNotes 设置',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')] },
    );
    SettingsPanel.current = new SettingsPanel(context, panel);
    return SettingsPanel.current.waitForReady();
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
      panel.webview.onDidReceiveMessage((message: unknown) => this.receive(message)),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private refresh(): void {
    this.version++;
    void this.postState().catch(error => {
      log.error('刷新设置页失败。', error);
      if (!this.disposed) { void this.panel.webview.postMessage({ type: 'error', requestId: 0, message: error instanceof Error ? error.message : String(error) }); }
    });
  }

  private receive(value: unknown): Promise<void> {
    let message: InboundMessage;
    try { message = parseInbound(value); }
    catch (error) {
      const invalid = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      void this.panel.webview.postMessage({ type: 'error', requestId: typeof invalid.requestId === 'number' ? invalid.requestId : 0,
        key: typeof invalid.key === 'string' ? invalid.key : undefined, message: error instanceof Error ? error.message : String(error) });
      return Promise.resolve();
    }
    this.queue = this.queue.then(async () => {
      if (this.disposed) { return; }
      this.activeRequestId = message.requestId ?? 0;
      try { await this.handleMessage(message); }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.warn(reason);
        void this.panel.webview.postMessage({ type: 'error', requestId: this.activeRequestId,
          key: message.type === 'update' ? message.key : undefined, message: reason });
      } finally { this.activeRequestId = 0; }
    });
    return this.queue;
  }

  private dispose(): void {
    this.disposed = true;
    this.resolveReady?.();
    if (SettingsPanel.current === this) {
      SettingsPanel.current = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private async waitForReady(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.ready, new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error('设置页加载超时，请重新打开。')), 10_000);
      })]);
    } catch (error) {
      this.panel.dispose();
      throw error;
    } finally {
      if (timer) { clearTimeout(timer); }
    }
  }

  private async handleMessage(message: InboundMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.resolveReady?.();
        await this.postState();
        return;

      case 'update':
        await updateConfig(message.key, message.value);
        this.version++;
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
        const saved = await setSecretFor(this.context, message.provider, message.value, this.targetConfig(message));
        this.postResult(
          message.provider,
          saved,
          saved ? '凭据已保存到系统密钥库。' : '请先填写上方的地址，凭据需要与地址绑定保存。',
        );
        await this.postState();
        return;
      }

      case 'clearCredential': {
        const cleared = await deleteSecretFor(this.context, message.provider, this.targetConfig(message));
        this.postResult(message.provider, cleared, cleared ? '凭据已清除。' : '当前地址没有对应的凭据。');
        await this.postState();
        return;
      }

      case 'testConnection':
        await this.testConnection(message.provider, this.targetConfig(message));
        return;

      case 'sync':
        await vscode.commands.executeCommand('mynotes.sync');
        return;

      case 'openAdvancedSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:qunmei.mynotes');
        return;
    }
  }

  private targetConfig(message: Extract<InboundMessage, { provider: CredentialProvider }>): ReturnType<typeof getSyncConfig> {
    const config = getSyncConfig();
    if (message.target) {
      if (message.provider === 'git') { config.git.remoteUrl = message.target.url.trim(); }
      else { config.webdav.url = message.target.url.trim(); config.webdav.username = message.target.username.trim(); }
    }
    return config;
  }

  private async testConnection(provider: CredentialProvider, config: ReturnType<typeof getSyncConfig>): Promise<void> {
    const backend =
      provider === 'git' ? new GitSyncProvider(this.context, config) : new WebdavSyncProvider(this.context, config);
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
      void this.panel.webview.postMessage({ type: 'result', requestId: this.activeRequestId, target, ok, message });
    }
  }

  private async postState(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const version = this.version;
    const requestId = this.activeRequestId;
    const issues: ConfigurationIssue[] = [];
    const notes = getNotesConfig(issues);
    const config = getSyncConfig(issues);
    const [git, webdav] = await Promise.all([getSecretFor(this.context, 'git', config), getSecretFor(this.context, 'webdav', config)]);
    if (this.disposed || version !== this.version) { return; }
    void this.panel.webview.postMessage({
      type: 'state',
      requestId, version,
      notes,
      sync: config,
      issues,
      // 只回传「是否已设置」，密文本身绝不回到 webview
      credentials: {
        git: Boolean(git),
        webdav: Boolean(webdav),
      },
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'settings.css'));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'settings.js'));
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<link rel="stylesheet" href="${style}" />
</head>
<body>
${BODY}
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

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
  <p id="generalError" class="result err" role="alert"></p>

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
