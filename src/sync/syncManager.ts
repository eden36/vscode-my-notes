import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { getNotesConfig, getSyncConfig, type ConfigurationIssue, type SyncConfig } from '../config';
import { EditorState } from './editorState';
import { GitSyncProvider } from './git/gitSyncProvider';
import { notesKey } from './sharedState';
import { canonicalNotesPath, syncIdentity } from './syncIdentity';
import { SyncLock } from './syncLock';
import { readRunRecord, sharedStateDir, writeRunRecord, type RunRecord } from './stateStore';
import { isInside } from './syncPath';
import { finishResult, type SyncProvider, type SyncResult, type SyncTrigger } from './syncProvider';
import { WebdavSyncProvider } from './webdav/webdavSyncProvider';
export type { SyncTrigger } from './syncProvider';
export interface SyncEvent {
  taskId: string;
  configVersion: number;
  identity?: string;
  trigger: SyncTrigger;
  state: 'idle' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled' | 'busy' | 'disabled' | 'unconfigured';
  result?: SyncResult;
  error?: unknown;
  at: number;
}
/** 协调器只管理任务、触发与副作用生命周期，界面通过事件接入。 */
export class SyncManager implements vscode.Disposable {
  private readonly events = new vscode.EventEmitter<SyncEvent>();
  readonly onDidChangeState = this.events.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly state: vscode.Uri;
  private readonly editors: EditorState;
  private pending: SyncTrigger | undefined;
  private running: Promise<void> | undefined;
  /** 本地独占写盘链：拖放等写盘期间 requestSync 会等到写完再启动。 */
  private mutationQueue: Promise<void> = Promise.resolve();
  private controller: AbortController | undefined;
  private cancellation: vscode.CancellationTokenSource | undefined;
  private root: string | undefined;
  private ready: Promise<void> = Promise.resolve();
  private configVersion = 0;
  private disposed = false;
  private shutdown: Promise<void> | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private startupTimer: NodeJS.Timeout | undefined;
  private startupEnabled = false;
  private startupSignature = '';
  constructor(private readonly context: vscode.ExtensionContext) {
    this.state = context.extensionMode === 1 ? sharedStateDir() : context.globalStorageUri;
    this.editors = new EditorState(this.state, () => this.cancel());
    this.disposables.push(vscode.window.onDidChangeWindowState(window => {
      if (window.focused) {
        void this.requestSync('focus');
      }
    }), vscode.workspace.onDidSaveTextDocument(document => {
      void this.onSaved(document).catch(error => {
        if (!this.disposed) {
          this.events.fire({ taskId: randomUUID(), configVersion: this.configVersion,
            trigger: 'save', state: 'failed', error, at: Date.now() });
        }
      });
    }));
    void this.reconfigure();
  }
  reconfigure(): Promise<void> {
    const version = ++this.configVersion;
    this.cancel();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.ready = this.ready.catch(() => undefined).then(async () => {
      const location = getNotesConfig().notesLocation;
      let root: string | undefined;
      if (location) {
        try {
          root = await canonicalNotesPath(location);
        }
        catch {
          root = undefined;
        }
      }
      if (this.disposed || version !== this.configVersion) {
        return;
      }
      this.root = root;
      await this.editors.setRoot(root);
      await vscode.commands.executeCommand('setContext', 'syncnotes.syncEnabled', getSyncConfig().provider !== 'none');
      if (this.startupEnabled) {
        this.scheduleStartupSync();
      }
    }).catch(error => {
      this.root = undefined;
      if (!this.disposed) {
        this.events.fire({
          taskId: randomUUID(), configVersion: version, trigger: 'focus', state: 'failed', error, at: Date.now()
        });
      }
    });
    return this.ready;
  }
  scheduleStartupSync(): void {
    this.startupEnabled = true;
    const issues: ConfigurationIssue[] = [];
    const config = getSyncConfig(issues);
    const location = getNotesConfig(issues).notesLocation;
    const signature = JSON.stringify([config.provider, config.onStartup, location, issues,
    config.git.remoteUrl, config.git.branch, config.webdav]);
    if (signature === this.startupSignature) {
      return;
    }
    this.startupSignature = signature;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    if (this.disposed || issues.length || !config.onStartup || config.provider === 'none') {
      return;
    }
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      void this.requestSync('startup');
    }, 5000 + Math.random() * 5000);
  }
  private async onSaved(document: vscode.TextDocument): Promise<void> {
    const version = this.configVersion;
    const config = getSyncConfig();
    if (this.disposed || !config.onSave || config.provider === 'none' || document.uri.scheme !== 'file') {
      return;
    }
    await this.ready;
    const root = await this.resolveRoot(version);
    if (!root) { return; }
    let file: string;
    try {
      file = await canonicalNotesPath(document.uri.fsPath);
    }
    catch {
      return;
    }
    if (this.disposed || version !== this.configVersion || !isInside(root, file)) {
      return;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    const deadline = Date.now() + config.onSaveDebounceSeconds * 1000;
    const schedule = () => {
      this.saveTimer = undefined;
      if (this.disposed) { return; }
      const remaining = deadline - Date.now();
      if (remaining <= 0) { void this.requestSync('save'); }
      else { this.saveTimer = setTimeout(schedule, Math.min(remaining, 2_147_483_647)); }
    };
    schedule();
  }
  requestSync(trigger: SyncTrigger): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    // 先等到本地独占写盘结束，避免与拖放等写盘并发
    return this.mutationQueue.then(() => this.startSync(trigger));
  }

  private startSync(trigger: SyncTrigger): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.running) {
      if (trigger === 'manual' || !this.pending) {
        this.pending = trigger;
      }
      return this.running;
    }
    this.running = this.drain(trigger).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async drain(trigger: SyncTrigger): Promise<void> {
    let current: SyncTrigger | undefined = trigger;
    while (current && !this.disposed) {
      try {
        await this.ready;
        await this.runOnce(current);
      }
      catch (error) {
        if (!this.disposed) {
          this.events.fire({
            taskId: randomUUID(), configVersion: this.configVersion, trigger: current, state: 'failed', error, at: Date.now()
          });
        }
      }
      current = this.pending;
      this.pending = undefined;
    }
  }
  cancel(): void {
    this.controller?.abort();
    this.cancellation?.cancel();
  }

  /** 取消当前同步并等到空闲。 */
  async waitUntilIdle(): Promise<void> {
    this.cancel();
    if (this.running) {
      await this.running;
    }
  }

  /**
   * 独占执行本地写盘：取消并等待同步空闲后执行；期间新的 requestSync 会排队到写盘结束。
   * 调用方应在返回后再 requestSync，避免在回调内同步等待自身互斥导致死锁。
   */
  async runExclusiveLocalWrite<T>(rootUri: vscode.Uri, fn: (assertActive: () => void) => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lease: SyncLock | undefined;
    try {
      await previous;
      await this.waitUntilIdle();
      if (this.disposed) { throw new vscode.CancellationError(); }
      const root = await canonicalNotesPath(rootUri.fsPath);
      lease = await SyncLock.acquire(this.state, notesKey(root), getSyncConfig().deviceName);
      if (!lease) { throw new Error('笔记目录正在由其他窗口同步或写入，请稍后重试。'); }
      const activeLease = lease;
      return await fn(() => {
        if (this.disposed) { throw new vscode.CancellationError(); }
        activeLease.assertActive();
      });
    } finally {
      try { await lease?.release(); } finally { release(); }
    }
  }
  /** 欢迎页或外部工具创建目录后，在下次保存或同步时恢复编辑登记。 */
  private async resolveRoot(version: number): Promise<string | undefined> {
    const location = getNotesConfig().notesLocation;
    if (!location) { return undefined; }
    const root = await canonicalNotesPath(location);
    if (this.disposed || version !== this.configVersion) { return undefined; }
    if (this.root !== root) {
      this.root = root;
      await this.editors.setRoot(root);
    }
    return !this.disposed && version === this.configVersion ? root : undefined;
  }
  private async runOnce(trigger: SyncTrigger): Promise<void> {
    const config: Readonly<SyncConfig> = Object.freeze(getSyncConfig());
    Object.freeze(config.git);
    Object.freeze(config.webdav);
    const version = this.configVersion;
    const taskId = randomUUID();
    let identity: string | undefined;
    const emit = (state: SyncEvent['state'], extra: Partial<SyncEvent> = {}) => {
      if (!this.disposed && version === this.configVersion) {
        this.events.fire({
          taskId, configVersion: version, identity, trigger, state, at: Date.now(), ...extra
        });
      }
    };
    if (config.provider === 'none') {
      emit('disabled');
      return;
    }
    if ((trigger === 'save' && !config.onSave) || (trigger === 'startup' && !config.onStartup) ||
      (trigger === 'focus' && !config.onWindowFocus)) {
      return;
    }
    if (!getNotesConfig().notesLocation) {
      emit('unconfigured');
      return;
    }
    let lease: SyncLock | undefined;
    let record: RunRecord | undefined;
    this.controller = new AbortController();
    this.cancellation = new vscode.CancellationTokenSource();
    try {
      const root = await this.resolveRoot(version);
      if (!root) { return; }
      identity = syncIdentity(root, config);
      if (this.disposed || version !== this.configVersion) {
        return;
      }
      lease = await SyncLock.acquire(this.state, notesKey(root), config.deviceName);
      if (!lease) {
        emit('busy');
        return;
      }
      record = await readRunRecord(this.state, identity);
      if (trigger === 'focus') {
        const cooldown = Math.max((record?.lastSuccessAt ?? 0) + config.focusCooldownSeconds * 1000, record && record.outcome !== 'complete' ? record.lastAttemptAt + 60000 : 0);
        if (Date.now() < cooldown) {
          return;
        }
      }
      emit('running');
      record = {
        version: 2, taskId, configVersion: version, trigger, lastAttemptAt: Date.now(), lastSuccessAt: record?.lastSuccessAt ?? 0, outcome: 'failed'
      };
      await writeRunRecord(this.state, identity, record);
      const provider: SyncProvider = config.provider === 'git'
        ? new GitSyncProvider(this.context, config) : new WebdavSyncProvider(this.context, config);
      await provider.validate();
      const signal = this.controller.signal;
      const token = this.cancellation.token;
      const activeLease = lease;
      const run = async (report: (message: string) => void) => provider.sync({
        root: vscode.Uri.file(root), config, identity, taskId, configVersion: version, trigger, deviceName: config.deviceName,
        stateUri: this.state, legacyStateUri: this.context.globalStorageUri, signal, token, report,
        assertActive: () => activeLease.assertActive(), isEditing: relative => this.editors.isEditing(relative),
      });
      const result = finishResult(trigger === 'manual' ? await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: '正在同步笔记', cancellable: true
      }, async (progress, cancellation) => {
        const subscription = cancellation.onCancellationRequested(() => this.cancel());
        try {
          return await run(message => progress.report({
            message
          }));
        }
        finally {
          subscription.dispose();
        }
      }) : await run(() => undefined));
      if (signal.aborted || token.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
      record.outcome = result.outcome;
      if (result.outcome === 'complete') {
        record.lastSuccessAt = Date.now();
      }
      activeLease.assertActive();
      await writeRunRecord(this.state, identity, record);
      emit(result.outcome, {
        result
      });
    }
    catch (error) {
      const cancelled = this.controller.signal.aborted || this.cancellation.token.isCancellationRequested || error instanceof vscode.CancellationError;
      if (record && identity && lease) {
        try {
          lease.assertActive();
          await writeRunRecord(this.state, identity, {
            ...record, outcome: cancelled ? 'cancelled' : 'failed'
          });
        }
        catch { /* 锁失效时由下一持有者管理共享记录。 */
        }
      }
      emit(cancelled ? 'cancelled' : 'failed', {
        error
      });
    }
    finally {
      try {
        await lease?.release();
      }
      catch (error) {
        emit('failed', {
          error
        });
      }
      this.cancellation.dispose();
      this.cancellation = undefined;
      this.controller = undefined;
    }
  }
  dispose(): Promise<void> {
    this.shutdown ??= this.close();
    return this.shutdown;
  }
  private async close(): Promise<void> {
    this.disposed = true;
    this.pending = undefined;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
    }
    this.cancel();
    this.disposables.forEach(disposable => disposable.dispose());
    await this.running;
    await this.mutationQueue;
    await this.ready.catch(() => undefined);
    await this.editors.dispose();
    this.events.dispose();
  }
}
