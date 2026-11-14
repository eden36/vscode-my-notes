import * as vscode from 'vscode';
import { getSyncConfig } from '../config';
import { log } from '../log';
import type { SyncEvent, SyncManager } from './syncManager';
import { isNoopResult, SyncConfigError } from './syncProvider';
/** 状态栏和通知统一消费任务事件，展示实际完成与待处理结果。 */
export class SyncPresentation implements vscode.Disposable {
  private readonly status: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;
  constructor(manager: SyncManager) {
    this.status = vscode.window.createStatusBarItem('mynotes.sync', vscode.StatusBarAlignment.Right, 100);
    this.status.name = 'MyNotes 同步';
    this.status.command = 'mynotes.sync';
    this.subscription = manager.onDidChangeState(event => this.present(event));
    this.reconfigure();
  }
  reconfigure(): void {
    if (getSyncConfig([]).provider === 'none') {
      this.status.hide();
    }
    else {
      this.status.text = '$(cloud) 笔记同步';
      this.status.tooltip = '点击立即同步';
      this.status.backgroundColor = undefined;
      this.status.show();
    }
  }
  private present(event: SyncEvent): void {
    const manual = event.trigger === 'manual';
    this.status.backgroundColor = undefined;
    if (event.state === 'disabled' || event.state === 'unconfigured') {
      if (manual) {
        void vscode.window.showInformationMessage(event.state === 'disabled' ? '尚未启用同步。' : '尚未设置笔记目录。', '打开设置')
          .then(choice => {
            if (choice) {
              void vscode.commands.executeCommand('mynotes.openSettings');
            }
          });
      }
      return;
    }
    if (event.state === 'running') {
      this.status.text = '$(sync~spin) 同步中';
      this.status.tooltip = '正在同步笔记';
      this.status.show();
      return;
    }
    if (event.state === 'busy' || event.state === 'cancelled') {
      const message = event.state === 'busy' ? '其他窗口正在同步' : '同步已取消';
      this.status.text = `$(cloud) ${message}`;
      this.status.tooltip = `${message}\n点击立即同步`;
      log.info(message);
      if (manual && event.state === 'busy') {
        void vscode.window.showInformationMessage('另一个窗口正在同步同一笔记目录，请稍后再试。');
      }
      return;
    }
    if (event.state === 'failed') {
      const message = event.error instanceof Error ? event.error.message : String(event.error);
      this.status.text = '$(warning) 同步失败';
      this.status.tooltip = `${message}\n点击重试`;
      this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      log.error('同步失败', event.error);
      if (manual) {
        const action = event.error instanceof SyncConfigError ? '打开设置' : '查看日志';
        void vscode.window.showErrorMessage(`同步失败：${message}`, action).then(choice => {
          if (choice === '打开设置') {
            void vscode.commands.executeCommand('mynotes.openSettings');
          }
          else if (choice) {
            log.show();
          }
        });
      }
      return;
    }
    const result = event.result;
    if (!result) {
      return;
    }
    const summary = `上传 ${result.uploaded.length}，下载 ${result.downloaded.length}，删除本地 ${result.deletedLocal.length}，` +
      `删除远端 ${result.deletedRemote.length}，冲突 ${result.conflicts.length}，失败 ${result.failures.length}，` +
      `延后 ${result.deferred.length}，待核实 ${result.pending.length}，待推送 ${result.pendingPush.length}`;
    this.status.text = event.state === 'partial' ? '$(warning) 同步部分完成' : `$(check) 已同步 ${new Date(event.at).toLocaleTimeString()}`;
    this.status.tooltip = `${summary}\n点击立即同步`;
    log.info(summary);
    for (const conflict of result.conflicts) {
      log.warn(`${conflict.relativePath}：${conflict.description}`);
    }
    for (const item of [...result.failures, ...result.deferred, ...result.pending]) {
      log.warn(`${item.relativePath}：${item.reason}`);
    }
    result.warnings.forEach(warning => log.warn(warning));
    if (result.conflicts.length || result.warnings.length || event.state === 'partial') {
      const conflict = result.conflicts[0];
      const actions = conflict ? ['打开冲突文件', '查看日志'] : ['查看日志'];
      void vscode.window.showWarningMessage(result.warnings[0] ?? summary, ...actions).then(async (choice) => {
        if (choice === '打开冲突文件' && conflict) {
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(conflict.copyUri));
        }
        else if (choice === '查看日志') {
          log.show();
        }
      });
    }
    else if (manual) {
      void vscode.window.showInformationMessage(isNoopResult(result) ? '同步完成，无变更。' : `同步完成：${summary}`);
    }
  }
  dispose(): void {
    this.subscription.dispose();
    this.status.dispose();
  }
}
