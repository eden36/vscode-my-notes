import { isOutboundMessage, type InboundMessage } from '../protocol';
declare function acquireVsCodeApi(): {
  postMessage(message: InboundMessage): void;
};
let sequence = 0;
let stateVersion = 0;
const resultRequests = new Map<string, number>();
const fieldIds = new Map<string, string>();
function send(message: InboundMessage): void {
  $('generalError').textContent = '';
  const requestId = ++sequence;
  const payload = {
    ...message, requestId, version: stateVersion
  };
  if ('provider' in payload) {
    payload.target = {
      url: $(payload.provider === 'git' ? 'gitRemoteUrl' : 'webdavUrl').value, username: payload.provider === 'webdav' ? $('webdavUsername').value : ''
    };
    resultRequests.set(payload.provider, requestId);
  }
  vscode.postMessage(payload);
}
const vscode = acquireVsCodeApi();
function $<T extends HTMLElement = HTMLInputElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`设置页缺少元素：${id}`);
  }
  return element as T;
}
function bindText(id: string, key: string, transform?: (value: string) => unknown) {
  const el = $(id);
  el.addEventListener('input', () => el.setCustomValidity(''));
  fieldIds.set(key, id);
  el.addEventListener('change', () => {
    send({
      type: 'update', key, value: transform ? transform(el.value) : el.value
    });
  });
}
function bindCheckbox(id: string, key: string) {
  const el = $(id);
  el.addEventListener('input', () => el.setCustomValidity(''));
  fieldIds.set(key, id);
  el.addEventListener('change', () => send({
    type: 'update', key, value: el.checked
  }));
}
function bindNumber(id: string, key: string) {
  const el = $(id);
  el.addEventListener('input', () => el.setCustomValidity(''));
  fieldIds.set(key, id);
  el.addEventListener('change', () => {
    const n = Number(el.value);
    if (Number.isFinite(n)) {
      send({
        type: 'update', key, value: n
      });
    }
  });
}
bindText('notesLocation', 'notesLocation');
bindText('defaultNoteExtension', 'defaultNoteExtension');
bindText('noteExtensions', 'noteExtensions', (v) => v.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
bindText('provider', 'sync.provider');
bindCheckbox('onStartup', 'sync.onStartup');
bindCheckbox('onWindowFocus', 'sync.onWindowFocus');
bindNumber('focusCooldownSeconds', 'sync.focusCooldownSeconds');
bindCheckbox('onSave', 'sync.onSave');
bindNumber('onSaveDebounceSeconds', 'sync.onSaveDebounceSeconds');
bindText('deviceName', 'sync.deviceName');
bindText('gitRemoteUrl', 'sync.git.remoteUrl');
bindText('gitBranch', 'sync.git.branch');
bindText('gitCommitMessageTemplate', 'sync.git.commitMessageTemplate');
bindText('gitUserName', 'sync.git.userName');
bindText('gitUserEmail', 'sync.git.userEmail');
bindText('webdavUrl', 'sync.webdav.url');
bindText('webdavRemotePath', 'sync.webdav.remotePath');
bindText('webdavUsername', 'sync.webdav.username');
$('browseBtn').addEventListener('click', () => send({
  type: 'browseNotesLocation'
}));
$('syncNowBtn').addEventListener('click', () => send({
  type: 'sync'
}));
$('advancedLink').addEventListener('click', () => send({
  type: 'openAdvancedSettings'
}));
function bindCredential(provider: 'git' | 'webdav', inputId: string, saveId: string, clearId: string) {
  $(saveId).addEventListener('click', () => {
    const input = $(inputId);
    send({
      type: 'saveCredential', provider, value: input.value
    });
    input.value = '';
  });
  $(clearId).addEventListener('click', () => {
    $(inputId).value = '';
    send({
      type: 'clearCredential', provider
    });
  });
}
bindCredential('git', 'gitToken', 'gitSaveTokenBtn', 'gitClearTokenBtn');
bindCredential('webdav', 'webdavPassword', 'webdavSaveTokenBtn', 'webdavClearTokenBtn');
function bindTest(provider: 'git' | 'webdav', buttonId: string) {
  $(buttonId).addEventListener('click', () => {
    const btn = $(buttonId);
    btn.disabled = true;
    btn.textContent = '测试中…';
    showResult(provider, null, '正在连接…');
    send({
      type: 'testConnection', provider
    });
  });
}
bindTest('git', 'gitTestBtn');
bindTest('webdav', 'webdavTestBtn');
const RESULT_ELEMENTS = {
  git: 'gitResult', webdav: 'webdavResult'
};
const BUSY_BUTTONS = {
  git: ['gitTestBtn', '测试连接'], webdav: ['webdavTestBtn', '测试连接']
};
function showResult(target: 'git' | 'webdav', ok: boolean | null, message: string) {
  const el = $(RESULT_ELEMENTS[target]);
  el.textContent = message;
  el.classList.toggle('ok', ok === true);
  el.classList.toggle('err', ok === false);
}
// 焦点中的字段不被自动刷新覆盖，避免打断正在输入的内容
function setIfNotFocused(el: HTMLInputElement, value: string | number) {
  if (document.activeElement !== el) {
    el.value = String(value);
  }
}
window.addEventListener('message', (event) => {
  const message: unknown = event.data;
  if (!isOutboundMessage(message)) {
    return;
  }
  if (message.type === 'error') {
    for (const target of ['git', 'webdav'] as const) {
      if (resultRequests.get(target) === message.requestId) {
        const [buttonId, label] = BUSY_BUTTONS[target];
        $(buttonId).disabled = false;
        $(buttonId).textContent = label;
        showResult(target, false, message.message);
      }
    }
    const id = message.key ? fieldIds.get(message.key) : undefined;
    if (id) {
      $(id).setCustomValidity(message.message);
      $(id).reportValidity();
    }
    else {
      $('generalError').textContent = message.message;
    }
    return;
  }
  if (message.type === 'result') {
    if (resultRequests.get(message.target) !== message.requestId) {
      return;
    }
    showResult(message.target, message.ok, message.message);
    const [buttonId, label] = BUSY_BUTTONS[message.target];
    const btn = $(buttonId);
    btn.disabled = false;
    btn.textContent = label;
    return;
  }
  if (message.type !== 'state' || message.version < stateVersion) {
    return;
  }
  stateVersion = message.version;
  const { notes, sync, credentials } = message;
  for (const id of fieldIds.values()) { $(id).setCustomValidity(''); }
  setIfNotFocused($('notesLocation'), notes.notesLocation);
  setIfNotFocused($('defaultNoteExtension'), notes.defaultNoteExtension);
  setIfNotFocused($('noteExtensions'), notes.allExtensions ? '*' : notes.noteExtensions.join(', '));
  $('provider').value = sync.provider;
  $('onStartup').checked = sync.onStartup;
  $('onWindowFocus').checked = sync.onWindowFocus;
  setIfNotFocused($('focusCooldownSeconds'), sync.focusCooldownSeconds);
  $('onSave').checked = sync.onSave;
  setIfNotFocused($('onSaveDebounceSeconds'), sync.onSaveDebounceSeconds);
  setIfNotFocused($('deviceName'), sync.deviceName);
  setIfNotFocused($('gitRemoteUrl'), sync.git.remoteUrl);
  setIfNotFocused($('gitBranch'), sync.git.branch);
  setIfNotFocused($('gitCommitMessageTemplate'), sync.git.commitMessageTemplate);
  setIfNotFocused($('gitUserName'), sync.git.userName);
  setIfNotFocused($('gitUserEmail'), sync.git.userEmail);
  setIfNotFocused($('webdavUrl'), sync.webdav.url);
  setIfNotFocused($('webdavRemotePath'), sync.webdav.remotePath);
  setIfNotFocused($('webdavUsername'), sync.webdav.username);
  $('generalError').textContent = (message.issues ?? []).map(issue => `${issue.key}：${issue.message}`).join('\n');
  for (const issue of message.issues ?? []) {
    const id = fieldIds.get(issue.key);
    if (!id) { continue; }
    const element = $(id);
    if (typeof issue.value === 'string' || typeof issue.value === 'number') { setIfNotFocused(element, issue.value); }
    element.setCustomValidity(issue.message);
  }
  // 只展示当前选中后端的参数，避免两套配置同时铺在页面上
  $('gitSection').classList.toggle('hidden', sync.provider !== 'git');
  $('webdavSection').classList.toggle('hidden', sync.provider !== 'webdav');
  $('noProviderHint').classList.toggle('hidden', sync.provider !== 'none');
  $('syncNowBtn').style.display = sync.provider === 'none' ? 'none' : '';
  for (const [provider, id] of [['git', 'gitCredentialStatus'], ['webdav', 'webdavCredentialStatus']] as const) {
    const el = $(id);
    const has = credentials[provider];
    el.classList.toggle('set', has);
    el.querySelector('.text')!.textContent = has ? '已保存凭据' : '尚未保存凭据';
  }
});
send({
  type: 'ready'
});
