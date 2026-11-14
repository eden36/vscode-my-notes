import type { ConfigurationIssue, NotesConfig, SyncConfig } from '../config';
type Provider = 'git' | 'webdav';
export type InboundMessage = ({
  requestId?: number;
  version?: number;
} & ({
  type: 'ready' | 'browseNotesLocation' | 'sync' | 'openAdvancedSettings';
} | {
  type: 'update';
  key: string;
  value: unknown;
} | {
  type: 'saveCredential';
  provider: Provider;
  value: string;
  target?: {
    url: string;
    username: string;
  };
} | {
  type: 'clearCredential' | 'testConnection';
  provider: Provider;
  target?: {
    url: string;
    username: string;
  };
}));
export type OutboundMessage = {
  type: 'state';
  requestId: number;
  version: number;
  notes: NotesConfig;
  sync: SyncConfig;
  issues?: ConfigurationIssue[];
  credentials: {
    git: boolean;
    webdav: boolean;
  };
} | {
  type: 'result';
  requestId: number;
  target: Provider;
  ok: boolean;
  message: string;
} | {
  type: 'error';
  requestId: number;
  key?: string;
  message: string;
};
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
const TEXT_KEYS = new Set(['notesLocation', 'defaultNoteExtension', 'sync.deviceName', 'sync.git.remoteUrl',
  'sync.git.branch', 'sync.git.commitMessageTemplate', 'sync.git.userName', 'sync.git.userEmail',
  'sync.webdav.url', 'sync.webdav.remotePath', 'sync.webdav.username']);
const BOOLEAN_KEYS = new Set(['sync.onStartup', 'sync.onWindowFocus', 'sync.onSave']);
const NUMBER_KEYS = new Set(['sync.focusCooldownSeconds', 'sync.onSaveDebounceSeconds']);
function validExtension(value: string): boolean {
  const normalized = value.trim().replace(/^\./, '');
  // eslint-disable-next-line no-control-regex
  const reserved = /[\\/:*?"<>|\x00-\x1f]/;
  return normalized.length > 0 && normalized.length <= 200 && !reserved.test(normalized) && !normalized.endsWith('.');
}
/** Webview 与宿主共同使用字段白名单，非法值在写入设置前报告。 */
export function validateConfigUpdate(key: string, value: unknown): void {
  if (TEXT_KEYS.has(key) && typeof value === 'string') {
    if (key === 'sync.git.remoteUrl' && value.trim().startsWith('-')) {
      throw new Error('Git 仓库地址不能以连字符开头。');
    }
    if (key === 'defaultNoteExtension' && !validExtension(value)) {
      throw new Error('默认扩展名无效，不能包含路径分隔符或文件名保留字符。');
    }
    if (key === 'sync.git.branch' && (!value.trim() || /[\s~^:?*[\\]/.test(value) || value.includes('..') || value.startsWith('-'))) {
      throw new Error('Git 分支名称无效。');
    }
    if (key === 'sync.webdav.url' && value.trim()) {
      let url: URL;
      try {
        url = new URL(value);
      }
      catch {
        throw new Error('WebDAV 服务地址无效。');
      }
      if (!['https:', 'http:'].includes(url.protocol) || url.password || url.username) {
        throw new Error('WebDAV 地址必须使用 HTTP 或 HTTPS，账号和密码请单独填写。');
      }
    }
    if (key === 'sync.webdav.remotePath' && value.replace(/\\/g, '/').split('/').some(segment => segment === '.' || segment === '..')) {
      throw new Error('远端目录不能包含 . 或 .. 路径段。');
    }
    if (key === 'sync.git.remoteUrl' && /^https?:/i.test(value)) {
      let url: URL;
      try {
        url = new URL(value);
      }
      catch {
        throw new Error('Git 仓库地址无效。');
      }
      if (url.password) {
        throw new Error('Git 密码或令牌请保存到系统密钥库。');
      }
    }
    return;
  }
  if (BOOLEAN_KEYS.has(key) && typeof value === 'boolean') {
    return;
  }
  if (NUMBER_KEYS.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= (key === 'sync.focusCooldownSeconds' ? 10 : 1)) {
    return;
  }
  if (key === 'noteExtensions' && Array.isArray(value) && value.every(entry => typeof entry === 'string' && (entry === '*' || validExtension(entry)))) {
    return;
  }
  if (key === 'sync.provider' && typeof value === 'string' && ['none', 'git', 'webdav'].includes(value)) {
    return;
  }
  throw new Error(`配置项无效或参数错误：${key}`);
}
export function parseInbound(value: unknown): InboundMessage {
  if (!record(value) || typeof value.type !== 'string' ||
    (value.requestId !== undefined && (!Number.isSafeInteger(value.requestId) || Number(value.requestId) < 0))) {
    throw new Error('设置消息格式无效。');
  }
  if (['ready', 'browseNotesLocation', 'sync', 'openAdvancedSettings'].includes(value.type)) {
    return value as InboundMessage;
  }
  if (value.type === 'update' && typeof value.key === 'string') {
    validateConfigUpdate(value.key, value.value);
    return value as InboundMessage;
  }
  if (['saveCredential', 'clearCredential', 'testConnection'].includes(value.type) && typeof value.provider === 'string' && ['git', 'webdav'].includes(value.provider)) {
    if (value.type === 'saveCredential' && typeof value.value !== 'string') {
      throw new Error('凭据参数错误。');
    }
    if (value.target !== undefined && (!record(value.target) || typeof value.target.url !== 'string' || typeof value.target.username !== 'string')) {
      throw new Error('凭据目标参数错误。');
    }
    return value as InboundMessage;
  }
  throw new Error('设置消息类型无效。');
}
export function isOutboundMessage(value: unknown): value is OutboundMessage {
  if (!record(value) || !Number.isSafeInteger(value.requestId)) {
    return false;
  }
  if (value.type === 'error') {
    return typeof value.message === 'string';
  }
  if (value.type === 'result') {
    return typeof value.target === 'string' && ['git', 'webdav'].includes(value.target) && typeof value.ok === 'boolean' && typeof value.message === 'string';
  }
  return value.type === 'state' && Number.isSafeInteger(value.version) && record(value.notes) && record(value.sync) &&
    record(value.credentials) && typeof value.notes.notesLocation === 'string' &&
    typeof value.sync.provider === 'string' && ['none', 'git', 'webdav'].includes(value.sync.provider);
}
