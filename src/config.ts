import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { validateConfigUpdate } from './settings/protocol';

export const CONFIG_SECTION = 'syncnotes';
export interface ConfigurationIssue { key: string; value: unknown; message: string }

/** 手工编辑设置文件时同样校验类型，兼容旧版的空扩展名和空分支。 */
function readSetting<T>(cfg: vscode.WorkspaceConfiguration, key: string, fallback: T, issues?: ConfigurationIssue[]): T {
  let value: unknown = cfg.get<unknown>(key, fallback);
  if (typeof value === 'string' && ['defaultNoteExtension', 'sync.git.branch'].includes(key)) {
    value = value.trim();
  }
  if (typeof value === 'string' && ['defaultNoteExtension', 'sync.git.branch'].includes(key) && !value.trim().replace(/^\./, '')) {
    value = fallback;
  }
  if (key === 'noteExtensions' && Array.isArray(value)) {
    value = value.map(entry => typeof entry === 'string' ? entry.trim() : entry)
      .filter(entry => typeof entry !== 'string' || entry.length);
  }
  try {
    validateConfigUpdate(key, value);
    if (key === 'notesLocation' && typeof value === 'string' && expandHome(value) && !path.isAbsolute(expandHome(value))) {
      throw new Error('笔记目录必须为绝对路径。');
    }
  } catch (error) {
    if (!issues) { throw error; }
    issues.push({ key, value, message: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
  return value as T;
}

export type SyncProviderId = 'none' | 'git' | 'webdav';

export interface NotesConfig {
  /** 展开 `~` 后的绝对路径；空字符串表示尚未配置 */
  notesLocation: string;
  defaultNoteExtension: string;
  /** 已归一化为小写、不带前导点的扩展名列表 */
  noteExtensions: string[];
  /** 配置中含 `*`，表示所有文件都视为笔记 */
  allExtensions: boolean;
  /** 树内拖放移动前是否确认（对齐 explorer.confirmDragAndDrop） */
  confirmDragAndDrop: boolean;
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

/** 界面传入 issues 收集错误以便修复，同步任务省略参数并严格拒绝非法配置。 */
export function getNotesConfig(issues?: ConfigurationIssue[]): NotesConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const read = <T>(key: string, fallback: T) => readSetting(cfg, key, fallback, issues);
  const rawExtensions = read<string[]>('noteExtensions', ['md', 'txt']);
  const normalized = rawExtensions
    .map((ext) => ext.trim().replace(/^\./, '').toLowerCase())
    .filter((ext) => ext.length > 0);

  const location = expandHome(read<string>('notesLocation', ''));
  return {
    notesLocation: location ? path.normalize(location) : '',
    defaultNoteExtension: read<string>('defaultNoteExtension', 'md').trim().replace(/^\./, '') || 'md',
    noteExtensions: normalized.filter((ext) => ext !== '*'),
    allExtensions: normalized.includes('*'),
    confirmDragAndDrop: read<boolean>('confirmDragAndDrop', true),
  };
}

export function getSyncConfig(issues?: ConfigurationIssue[]): SyncConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const read = <T>(key: string, fallback: T) => readSetting(cfg, key, fallback, issues);
  return {
    provider: read<SyncProviderId>('sync.provider', 'none'),
    onStartup: read<boolean>('sync.onStartup', true),
    onWindowFocus: read<boolean>('sync.onWindowFocus', true),
    focusCooldownSeconds: read<number>('sync.focusCooldownSeconds', 300),
    onSave: read<boolean>('sync.onSave', false),
    onSaveDebounceSeconds: read<number>('sync.onSaveDebounceSeconds', 30),
    deviceName: read<string>('sync.deviceName', '').trim() || os.hostname(),
    git: {
      remoteUrl: read<string>('sync.git.remoteUrl', '').trim(),
      branch: read<string>('sync.git.branch', 'main').trim() || 'main',
      commitMessageTemplate: read<string>('sync.git.commitMessageTemplate', 'notes: {device} {datetime}'),
      userName: read<string>('sync.git.userName', '').trim(),
      userEmail: read<string>('sync.git.userEmail', '').trim(),
    },
    webdav: {
      url: read<string>('sync.webdav.url', '').trim(),
      remotePath: read<string>('sync.webdav.remotePath', '/syncnotes').trim() || '/',
      username: read<string>('sync.webdav.username', '').trim(),
    },
  };
}

/** application 配置统一写入用户级设置。 */
export async function updateConfig(key: string, value: unknown): Promise<void> {
  validateConfigUpdate(key, value);
  if (key === 'notesLocation' && typeof value === 'string' && value.trim() && !path.isAbsolute(expandHome(value))) {
    throw new Error('笔记目录必须为绝对路径。');
  }
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update(key, value, vscode.ConfigurationTarget.Global);
}

/** 判断文件名是否应作为笔记显示在树视图中 */
export function isNoteFile(fileName: string, cfg: NotesConfig): boolean {
  if (cfg.allExtensions) {
    return true;
  }
  const ext = path.extname(fileName).replace(/^\./, '').toLowerCase();
  return ext.length > 0 && cfg.noteExtensions.includes(ext);
}
