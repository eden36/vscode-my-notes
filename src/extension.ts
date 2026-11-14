import * as vscode from 'vscode';
import { CONFIG_SECTION } from './config';
import { initLog, log } from './log';
import { registerNoteCommands } from './notes/noteCommands';
import { NotesTreeProvider } from './notes/notesTreeProvider';
import { SettingsPanel } from './settings/settingsPanel';
import { registerSyncCommands } from './sync/syncCommands';
import { SyncManager } from './sync/syncManager';
import { SyncPresentation } from './sync/syncPresentation';

let activeManager: SyncManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  initLog(context);

  const treeProvider = new NotesTreeProvider();
  context.subscriptions.push(treeProvider);

  const treeView = vscode.window.createTreeView('mynotes.notesView', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  const syncManager = new SyncManager(context);
  activeManager = syncManager;
  context.subscriptions.push(syncManager);
  const presentation = new SyncPresentation(syncManager);
  context.subscriptions.push(presentation, syncManager.onDidChangeState(event => {
    if (event.result) { treeProvider.refresh(); }
  }));

  registerNoteCommands(context, treeProvider, treeView);
  registerSyncCommands(context, syncManager);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) {
        return;
      }
      await treeProvider.reconfigure();
      await syncManager.reconfigure();
      presentation.reconfigure();
      SettingsPanel.refreshIfOpen();
    }),
  );
  if (context.secrets.onDidChange) {
    context.subscriptions.push(context.secrets.onDidChange(() => SettingsPanel.refreshIfOpen()));
  }

  syncManager.scheduleStartupSync();
  log.info('MyNotes 已启动');
}

export async function deactivate(): Promise<void> {
  await activeManager?.dispose();
  activeManager = undefined;
}
