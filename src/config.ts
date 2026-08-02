import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export const CONFIG_SECTION = 'mynotes';

export type SyncProviderId = 'none' | 'git' | 'webdav';

export interface NotesConfig {
  /** 展开 `~` 后的绝对路径；空字符串表示尚未配置 */
  notesLocation: string;
  defaultNoteExtension: string;
  /** 已归一化为小写、不带前导点的扩展名列表 */
  noteExtensions: string[];
  /** 配置中含 `*`，表示所有文件都视为笔记 */
  allExtensions: boolean;
}

export interface SyncConfig {
  provider: SyncProviderId;
  onStartup: boolean;
  onWindowFocus: boolean;
  focusCooldownSeconds: number;
  onSave: boolean;
  onSaveDebounceSeconds: number;
  deviceName: string;
  git: {
    remoteUrl: string;
    branch: string;
    commitMessageTemplate: string;
    userName: string;
    userEmail: string;
  };
  webdav: {
    url: string;
    remotePath: string;
    username: string;
  };
}

function expandHome(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed === '~') {
    return os.homedir();
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function getNotesConfig(): NotesConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rawExtensions = cfg.get<string[]>('noteExtensions', ['md', 'txt']);
  const normalized = rawExtensions
    .map((ext) => ext.trim().replace(/^\./, '').toLowerCase())
    .filter((ext) => ext.length > 0);

  const location = expandHome(cfg.get<string>('notesLocation', ''));

  return {
    notesLocation: location ? path.normalize(location) : '',
    defaultNoteExtension: cfg.get<string>('defaultNoteExtension', 'md').trim().replace(/^\./, '') || 'md',
    noteExtensions: normalized.filter((ext) => ext !== '*'),
    allExtensions: normalized.includes('*'),
  };
}

export function getSyncConfig(): SyncConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    provider: cfg.get<SyncProviderId>('sync.provider', 'none'),
    onStartup: cfg.get<boolean>('sync.onStartup', true),
    onWindowFocus: cfg.get<boolean>('sync.onWindowFocus', true),
    focusCooldownSeconds: cfg.get<number>('sync.focusCooldownSeconds', 300),
    onSave: cfg.get<boolean>('sync.onSave', false),
    onSaveDebounceSeconds: cfg.get<number>('sync.onSaveDebounceSeconds', 30),
    deviceName: cfg.get<string>('sync.deviceName', '').trim() || os.hostname(),
    git: {
      remoteUrl: cfg.get<string>('sync.git.remoteUrl', '').trim(),
      branch: cfg.get<string>('sync.git.branch', 'main').trim() || 'main',
      commitMessageTemplate: cfg.get<string>('sync.git.commitMessageTemplate', 'notes: {device} {datetime}'),
      userName: cfg.get<string>('sync.git.userName', '').trim(),
      userEmail: cfg.get<string>('sync.git.userEmail', '').trim(),
    },
    webdav: {
      url: cfg.get<string>('sync.webdav.url', '').trim(),
      remotePath: cfg.get<string>('sync.webdav.remotePath', '/mynotes').trim() || '/',
      username: cfg.get<string>('sync.webdav.username', '').trim(),
    },
  };
}

/**
 * 写回配置时选择该项当前已定义的作用域，而不是一律写用户设置。
 *
 * 工作区设置的优先级高于用户设置：若某项已写在工作区的 .vscode/settings.json 里，
 * 仍往用户设置写就会被覆盖，界面上表现为「改了没反应、值自动弹回去」。
 */
export async function updateConfig(key: string, value: unknown): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const inspected = config.inspect(key);

  let target = vscode.ConfigurationTarget.Global;
  if (inspected?.workspaceFolderValue !== undefined) {
    target = vscode.ConfigurationTarget.WorkspaceFolder;
  } else if (inspected?.workspaceValue !== undefined) {
    target = vscode.ConfigurationTarget.Workspace;
  }

  await config.update(key, value, target);
}

/** 判断文件名是否应作为笔记显示在树视图中 */
export function isNoteFile(fileName: string, cfg: NotesConfig): boolean {
  if (cfg.allExtensions) {
    return true;
  }
  const ext = path.extname(fileName).replace(/^\./, '').toLowerCase();
  return ext.length > 0 && cfg.noteExtensions.includes(ext);
}
