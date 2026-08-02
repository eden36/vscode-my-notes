import * as vscode from 'vscode';
import { getNotesConfig, getSyncConfig } from '../config';
import { log } from '../log';
import type { NotesTreeProvider } from '../notes/notesTreeProvider';
import { GitSyncProvider } from './git/gitSyncProvider';
import { notesKey, readLastSyncAt, sharedStateDir, SyncLock, writeLastSyncAt } from './sharedState';
import { isNoopResult, SyncConfigError, type SyncProvider, type SyncResult } from './syncProvider';
import { WebdavSyncProvider } from './webdav/webdavSyncProvider';

export type SyncTrigger = 'manual' | 'startup' | 'focus' | 'save';

const TRIGGER_LABEL: Record<SyncTrigger, string> = {
  manual: '手动触发',
  startup: '启动触发',
  focus: '窗口聚焦触发',
  save: '保存触发',
};

const STARTUP_DELAY_MS = 5000;
/** 多个窗口一起恢复会话时，固定延迟会让它们几乎同时开始同步，加抖动错开 */
const STARTUP_JITTER_MS = 5000;

export class SyncManager implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  private running = false;
  /** 同步进行中收到的新请求只保留一个，结束后补跑一次，避免请求堆积 */
  private pending: SyncTrigger | undefined;
  private lastSyncAt = 0;
  private saveTimer: NodeJS.Timeout | undefined;
  private startupTimer: NodeJS.Timeout | undefined;
  private cancelSource: vscode.CancellationTokenSource | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly tree: NotesTreeProvider,
  ) {
    this.statusBar = vscode.window.createStatusBarItem('mynotes.sync', vscode.StatusBarAlignment.Right, 100);
    this.statusBar.name = 'MyNotes 同步';
    this.statusBar.command = 'mynotes.sync';
    this.disposables.push(this.statusBar);

    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          void this.onWindowFocused();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onDocumentSaved(doc)),
    );

    void this.reconfigure();
  }

  /** 配置变更后刷新状态栏可见性与上下文键 */
  async reconfigure(): Promise<void> {
    const enabled = getSyncConfig().provider !== 'none';
    await vscode.commands.executeCommand('setContext', 'mynotes.syncEnabled', enabled);
    if (enabled) {
      if (this.lastSyncAt === 0) {
        this.setIdleStatus('尚未同步');
      }
      this.statusBar.show();
    } else {
      this.statusBar.hide();
    }
  }

  scheduleStartupSync(): void {
    if (!getSyncConfig().onStartup || getSyncConfig().provider === 'none') {
      return;
    }
    // 延迟启动，避开 VS Code 启动高峰
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      void this.requestSync('startup');
    }, STARTUP_DELAY_MS + Math.random() * STARTUP_JITTER_MS);
  }

  private async onWindowFocused(): Promise<void> {
    const cfg = getSyncConfig();
    if (cfg.provider === 'none' || !cfg.onWindowFocus) {
      return;
    }
    const notesLocation = getNotesConfig().notesLocation;
    if (!notesLocation) {
      return;
    }

    // 冷却依据共享的时间戳而非进程内变量：多开窗口时每个窗口各记各的，
    // 在窗口之间来回切换会让冷却完全失效，每切一次就触发一轮同步
    const lastSyncAt = await readLastSyncAt(sharedStateDir(), notesKey(notesLocation));
    if (Date.now() - lastSyncAt < cfg.focusCooldownSeconds * 1000) {
      return;
    }
    void this.requestSync('focus');
  }

  private onDocumentSaved(doc: vscode.TextDocument): void {
    const cfg = getSyncConfig();
    if (cfg.provider === 'none' || !cfg.onSave) {
      return;
    }
    const root = this.tree.rootUri;
    if (!root || !isInside(root, doc.uri)) {
      return;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.requestSync('save');
    }, cfg.onSaveDebounceSeconds * 1000);
  }

  async requestSync(trigger: SyncTrigger): Promise<void> {
    if (this.running) {
      // 手动触发的优先级最高，覆盖已排队的自动触发
      if (trigger === 'manual' || this.pending === undefined) {
        this.pending = trigger;
      }
      if (trigger === 'manual') {
        void vscode.window.showInformationMessage('同步正在进行中，将在本轮结束后再执行一次。');
      }
      return;
    }

    this.running = true;
    try {
      await this.runOnce(trigger);
    } finally {
      this.running = false;
      const next = this.pending;
      this.pending = undefined;
      if (next) {
        await this.requestSync(next);
      }
    }
  }

  cancel(): void {
    this.cancelSource?.cancel();
  }

  private async runOnce(trigger: SyncTrigger): Promise<void> {
    const syncCfg = getSyncConfig();
    const notesCfg = getNotesConfig();

    if (syncCfg.provider === 'none') {
      if (trigger === 'manual') {
        const choice = await vscode.window.showInformationMessage('尚未启用同步。', '打开设置');
        if (choice) {
          await vscode.commands.executeCommand('mynotes.openSettings');
        }
      }
      return;
    }

    if (!notesCfg.notesLocation) {
      if (trigger === 'manual') {
        void vscode.window.showWarningMessage('尚未设置笔记目录，无法同步。');
      }
      return;
    }

    const provider: SyncProvider =
      syncCfg.provider === 'git'
        ? new GitSyncProvider(this.context)
        : new WebdavSyncProvider(this.context);

    log.info(`开始同步（${TRIGGER_LABEL[trigger]}，后端：${provider.displayName}）`);
    this.setBusyStatus();

    this.cancelSource = new vscode.CancellationTokenSource();
    const token = this.cancelSource.token;
    const stateUri = sharedStateDir();
    const key = notesKey(notesCfg.notesLocation);

    try {
      await provider.validate();

      // running 标志只能约束本窗口，多开时每个窗口都是独立进程：不加跨进程锁，
      // 两个窗口会同时改写同一份基线，Git 后端还会直接撞上 index.lock
      const lock = await SyncLock.acquire(stateUri, key, syncCfg.deviceName);
      if (!lock) {
        log.info('另一个窗口正在同步该笔记目录，跳过本轮');
        this.setIdleStatus('其他窗口正在同步');
        if (trigger === 'manual') {
          void vscode.window.showInformationMessage('另一个 VS Code 窗口正在同步同一个笔记目录，请稍后再试。');
        }
        return;
      }

      try {
        const run = async (report: (message: string) => void): Promise<SyncResult> =>
          provider.sync({
            root: vscode.Uri.file(notesCfg.notesLocation),
            deviceName: syncCfg.deviceName,
            stateUri,
            legacyStateUri: this.context.globalStorageUri,
            token,
            report,
          });

        const result =
          trigger === 'manual'
            ? await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '正在同步笔记', cancellable: true },
                async (progress, progressToken) => {
                  progressToken.onCancellationRequested(() => this.cancelSource?.cancel());
                  return run((message) => progress.report({ message }));
                },
              )
            : await run(() => undefined);

        await this.markSynced(stateUri, key);
        this.tree.refresh();
        this.reportResult(result, trigger);
      } finally {
        await lock.release();
      }
    } catch (err) {
      await this.markSynced(stateUri, key);
      this.handleFailure(err, trigger);
    } finally {
      this.cancelSource?.dispose();
      this.cancelSource = undefined;
    }
  }

  /** 同步时间写入共享目录，供其他窗口判断聚焦冷却 */
  private async markSynced(stateUri: vscode.Uri, key: string): Promise<void> {
    this.lastSyncAt = Date.now();
    await writeLastSyncAt(stateUri, key, this.lastSyncAt);
  }

  private reportResult(result: SyncResult, trigger: SyncTrigger): void {
    const summary =
      `上传 ${result.uploaded.length}，下载 ${result.downloaded.length}，` +
      `删除本地 ${result.deletedLocal.length}，删除远端 ${result.deletedRemote.length}，` +
      `冲突 ${result.conflicts.length}，失败 ${result.failures.length}`;
    log.info(`同步完成：${summary}`);

    for (const conflict of result.conflicts) {
      log.warn(`冲突：${conflict.relativePath} → 远端版本已另存为 ${conflict.copyUri.fsPath}`);
    }
    for (const failure of result.failures) {
      log.warn(`处理失败：${failure.relativePath}（${failure.reason}）`);
    }
    for (const warning of result.warnings) {
      log.warn(warning);
    }

    this.setIdleStatus(isNoopResult(result) ? '无变更' : summary);

    // 基线丢失这类问题会影响用户对同步结果的判断，优先于逐个文件的冲突提示
    if (result.warnings.length > 0) {
      void vscode.window.showWarningMessage(result.warnings[0], '查看日志').then((choice) => {
        if (choice) {
          log.show();
        }
      });
      return;
    }

    if (result.conflicts.length > 0) {
      const first = result.conflicts[0];
      void vscode.window
        .showWarningMessage(
          `同步发现 ${result.conflicts.length} 处冲突，远端版本已另存为 .conflict- 开头的文件，本地内容未被覆盖。`,
          '打开冲突文件',
          '查看日志',
        )
        .then(async (choice) => {
          if (choice === '打开冲突文件') {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(first.copyUri));
          } else if (choice === '查看日志') {
            log.show();
          }
        });
      return;
    }

    if (result.failures.length > 0) {
      void vscode.window
        .showWarningMessage(`同步完成，但有 ${result.failures.length} 个文件处理失败。`, '查看日志')
        .then((choice) => {
          if (choice) {
            log.show();
          }
        });
      return;
    }

    if (trigger === 'manual') {
      void vscode.window.showInformationMessage(isNoopResult(result) ? '同步完成，无变更。' : `同步完成：${summary}`);
    }
  }

  private handleFailure(err: unknown, trigger: SyncTrigger): void {
    if (err instanceof vscode.CancellationError) {
      log.info('同步已取消');
      this.setIdleStatus('已取消');
      return;
    }

    const message = err instanceof SyncConfigError || err instanceof Error ? err.message : String(err);
    log.error('同步失败', err);
    this.statusBar.text = '$(warning) 同步失败';
    this.statusBar.tooltip = `${message}\n点击重试`;
    this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

    // 自动触发的失败不弹窗打扰，只在状态栏与日志中体现
    if (trigger !== 'manual') {
      return;
    }

    const actions = err instanceof SyncConfigError ? ['打开设置', '查看日志'] : ['查看日志'];
    void vscode.window.showErrorMessage(`同步失败：${message}`, ...actions).then(async (choice) => {
      if (choice === '打开设置') {
        await vscode.commands.executeCommand('mynotes.openSettings');
      } else if (choice === '查看日志') {
        log.show();
      }
    });
  }

  private setBusyStatus(): void {
    this.statusBar.text = '$(sync~spin) 同步中';
    this.statusBar.tooltip = '正在同步笔记';
    this.statusBar.backgroundColor = undefined;
    this.statusBar.show();
  }

  private setIdleStatus(detail: string): void {
    const time = this.lastSyncAt
      ? new Date(this.lastSyncAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : '';
    this.statusBar.text = time ? `$(check) 已同步 ${time}` : '$(cloud) 笔记同步';
    this.statusBar.tooltip = `${detail}\n点击立即同步`;
    this.statusBar.backgroundColor = undefined;
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
    }
    this.cancelSource?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/** 判断 uri 是否位于 root 目录内 */
function isInside(root: vscode.Uri, uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file') {
    return false;
  }
  const rootPath = normalizeForCompare(root.fsPath);
  const target = normalizeForCompare(uri.fsPath);
  return target === rootPath || target.startsWith(rootPath.endsWith('\\') || rootPath.endsWith('/') ? rootPath : `${rootPath}${pathSeparator()}`);
}

function pathSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

function normalizeForCompare(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}
