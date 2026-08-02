import * as vscode from 'vscode';
import { getSyncConfig } from '../config';
import { log } from '../log';
import { currentSecretKey, deleteSecret, setSecret } from './secrets';
import type { SyncManager } from './syncManager';

export function registerSyncCommands(
  context: vscode.ExtensionContext,
  manager: SyncManager,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('mynotes.sync', () => manager.requestSync('manual')),

    vscode.commands.registerCommand('mynotes.showLog', () => log.show()),

    vscode.commands.registerCommand('mynotes.setCredential', async () => {
      const cfg = getSyncConfig();
      if (!currentSecretKey()) {
        void vscode.window.showWarningMessage('请先配置同步后端及其地址，再设置凭据。');
        return;
      }

      const value = await vscode.window.showInputBox({
        title: cfg.provider === 'git' ? '设置 Git 访问令牌' : '设置 WebDAV 密码',
        prompt:
          cfg.provider === 'git'
            ? '输入个人访问令牌（PAT）。凭据保存在系统密钥库中，不会写入设置文件。'
            : '输入 WebDAV 密码或应用密码。凭据保存在系统密钥库中，不会写入设置文件。',
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) {
        return;
      }
      await setSecret(context, value);
      void vscode.window.showInformationMessage('凭据已保存。');
    }),

    vscode.commands.registerCommand('mynotes.clearCredential', async () => {
      if (!currentSecretKey()) {
        void vscode.window.showWarningMessage('当前配置没有对应的凭据。');
        return;
      }
      await deleteSecret(context);
      void vscode.window.showInformationMessage('凭据已清除。');
    }),
  );
}
