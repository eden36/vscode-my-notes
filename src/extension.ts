import * as vscode from 'vscode';
import { CONFIG_SECTION } from './config';
import { initLog, log } from './log';
import { registerNoteCommands } from './notes/noteCommands';
import { NotesTreeProvider } from './notes/notesTreeProvider';
import { SettingsPanel } from './settings/settingsPanel';
import { registerSyncCommands } from './sync/syncCommands';
import { SyncManager } from './sync/syncManager';

export function activate(context: vscode.ExtensionContext): void {
  initLog(context);

  const treeProvider = new NotesTreeProvider();
  context.subscriptions.push(treeProvider);

  const treeView = vscode.window.createTreeView('mynotes.notesView', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  const syncManager = new SyncManager(context, treeProvider);
  context.subscriptions.push(syncManager);

  registerNoteCommands(context, treeProvider, treeView);
  registerSyncCommands(context, syncManager);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) {
        return;
      }
      await treeProvider.reconfigure();
      await syncManager.reconfigure();
      SettingsPanel.refreshIfOpen();
    }),
  );

  syncManager.scheduleStartupSync();
  log.info('MyNotes 已启动');
}

export function deactivate(): void {
  // 资源均通过 context.subscriptions 释放
}
