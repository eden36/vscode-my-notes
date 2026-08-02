// 用 vscode 模块桩件加载打包产物，验证激活流程、命令注册与笔记树读取。
import Module from 'module';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

const NOTES = path.join(tmpdir(), 'mynotes-smoke', 'notes');
const STORAGE = path.join(tmpdir(), 'mynotes-smoke', 'storage');
rmSync(path.join(tmpdir(), 'mynotes-smoke'), { recursive: true, force: true });
mkdirSync(path.join(NOTES, '工作'), { recursive: true });
mkdirSync(STORAGE, { recursive: true });
writeFileSync(path.join(NOTES, '待办.md'), '# 待办\n');
writeFileSync(path.join(NOTES, 'readme.txt'), 'x\n');
writeFileSync(path.join(NOTES, 'ignored.bin'), 'x\n');
writeFileSync(path.join(NOTES, '工作', '周报.md'), '# 周报\n');

let failures = 0;

console.log('package.json 配置作用域');
{
  const repoRootForPkg = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const pkg = JSON.parse(await fsp.readFile(path.join(repoRootForPkg, 'package.json'), 'utf8'));
  const props = pkg.contributes.configuration.properties;

  // 期望「跨 Profile 共享 + 参与设置同步」的字段：scope 必须显式声明为 application，
  // 漏加会导致这些设置在 profile 切换后各自独立、也不会随 Settings Sync 带到别的电脑
  const expectedApplicationScope = [
    'mynotes.defaultNoteExtension', 'mynotes.noteExtensions',
    'mynotes.sync.provider', 'mynotes.sync.onStartup', 'mynotes.sync.onWindowFocus',
    'mynotes.sync.focusCooldownSeconds', 'mynotes.sync.onSave', 'mynotes.sync.onSaveDebounceSeconds',
    'mynotes.sync.git.remoteUrl', 'mynotes.sync.git.branch', 'mynotes.sync.git.commitMessageTemplate',
    'mynotes.sync.git.userName', 'mynotes.sync.git.userEmail',
    'mynotes.sync.webdav.url', 'mynotes.sync.webdav.remotePath', 'mynotes.sync.webdav.username',
  ];
  const wrongScope = expectedApplicationScope.filter((key) => props[key]?.scope !== 'application');
  check('应共享/同步的字段全部声明了 application 作用域', wrongScope, []);

  // notesLocation、deviceName 是「本机内共享、跨设备不共享」：
  // scope=application 让同一台电脑的各个 Profile 用同一份值，换 Profile 无需重设；
  // ignoreSync 才是阻止它们被同步到别的电脑的手段——这两件事由不同机制控制，
  // 早期版本用「不加 application」来阻止跨设备同步，实际只是让每个 Profile 各自为政
  const expectedLocalOnly = ['mynotes.notesLocation', 'mynotes.sync.deviceName'];
  const notShared = expectedLocalOnly.filter((key) => props[key]?.scope !== 'application');
  check('本机字段在各 Profile 之间共享', notShared, []);
  const notIgnored = expectedLocalOnly.filter((key) => props[key]?.ignoreSync !== true);
  check('本机字段已排除出 VS Code 设置同步', notIgnored, []);
}

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

class Uri {
  constructor(fsPath) { this.fsPath = fsPath; this.scheme = 'file'; }
  static file(p) { return new Uri(path.normalize(p)); }
  static joinPath(base, ...segs) { return new Uri(path.normalize(path.join(base.fsPath, ...segs))); }
  get path() { return this.fsPath.replace(/\\/g, '/'); }
  toString() { return 'file:///' + this.fsPath.replace(/\\/g, '/'); }
}

class EventEmitter {
  constructor() { this.handlers = []; }
  get event() { return (h) => { this.handlers.push(h); return { dispose() {} }; }; }
  fire(v) { for (const h of this.handlers) h(v); }
  dispose() {}
}

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

class TreeItem {
  constructor(labelOrUri, collapsibleState) {
    if (labelOrUri instanceof Uri) this.resourceUri = labelOrUri; else this.label = labelOrUri;
    this.collapsibleState = collapsibleState;
  }
}

class FakeWebview {
  constructor() { this.cspSource = 'vscode-resource:'; this.options = {}; this._html = ''; this._handlers = []; }
  set html(v) { this._html = v; }
  get html() { return this._html; }
  onDidReceiveMessage(handler) { this._handlers.push(handler); return { dispose() {} }; }
  postMessage(msg) { postedMessages.push(msg); return Promise.resolve(true); }
  async _receive(msg) { for (const h of this._handlers) await h(msg); }
}
class FakeWebviewPanel {
  constructor(viewType, title) {
    this.viewType = viewType;
    this.title = title;
    this.webview = new FakeWebview();
    this.revealCount = 0;
    this._disposeHandlers = [];
  }
  reveal() { this.revealCount++; }
  onDidDispose(handler) { this._disposeHandlers.push(handler); return { dispose() {} }; }
  dispose() { for (const h of this._disposeHandlers) h(); }
}

const postedMessages = [];
const secretStore = new Map();
const registeredCommands = new Map();
const contextKeys = new Map();
// 分层模拟配置作用域：工作区设置优先级高于用户设置。
// 不分层就测不出「写用户设置但被工作区设置覆盖」这类问题。
const globalSettings = new Map([
  ['mynotes.defaultNoteExtension', 'md'],
  ['mynotes.noteExtensions', ['md', 'txt']],
  ['mynotes.sync.provider', 'none'],
]);
const workspaceSettings = new Map([['mynotes.notesLocation', NOTES]]);

/** 读取最终生效的值，与 VS Code 的层级覆盖规则一致 */
function effectiveSetting(fullKey) {
  if (workspaceSettings.has(fullKey)) return workspaceSettings.get(fullKey);
  return globalSettings.get(fullKey);
}

const shownMessages = [];

const vscode = {
  Uri, EventEmitter, TreeItem, FileType,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ThemeColor: class { constructor(id) { this.id = id; } },
  CancellationError: class extends Error {},
  CancellationTokenSource: class {
    constructor() { this.token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }; }
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
  },
  RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
  window: {
    createOutputChannel: () => ({ trace() {}, info() {}, warn() {}, error() {}, show() {}, dispose() {} }),
    createTreeView: (id, options) => { vscode.__treeProvider = options.treeDataProvider; return { dispose() {}, reveal: async () => {} }; },
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    onDidChangeWindowState: () => ({ dispose() {} }),
    showInformationMessage: async (m) => { shownMessages.push(m); return undefined; },
    showWarningMessage: async (m) => { shownMessages.push(m); return undefined; },
    showErrorMessage: async (m) => { shownMessages.push(m); return undefined; },
    showQuickPick: async (items) => { vscode.__lastQuickPick = await items; return undefined; },
    showInputBox: async () => undefined,
    showOpenDialog: async () => undefined,
    showTextDocument: async () => ({}),
    withProgress: async (_o, task) => task({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
    createWebviewPanel: (viewType, title) => {
      const panel = new FakeWebviewPanel(viewType, title);
      vscode.__webviewPanels.push(panel);
      return panel;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, dflt) => {
        const full = `mynotes.${key}`;
        if (workspaceSettings.has(full)) return workspaceSettings.get(full);
        if (globalSettings.has(full)) return globalSettings.get(full);
        return dflt;
      },
      inspect: (key) => {
        const full = `mynotes.${key}`;
        return {
          key: full,
          globalValue: globalSettings.has(full) ? globalSettings.get(full) : undefined,
          workspaceValue: workspaceSettings.has(full) ? workspaceSettings.get(full) : undefined,
          workspaceFolderValue: undefined,
        };
      },
      update: async (key, value, target) => {
        const full = `mynotes.${key}`;
        if (target === vscode.ConfigurationTarget.Workspace) workspaceSettings.set(full, value);
        else if (target === vscode.ConfigurationTarget.WorkspaceFolder) workspaceSettings.set(full, value);
        else globalSettings.set(full, value);
      },
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    createFileSystemWatcher: () => ({ onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), onDidChange: () => ({ dispose() {} }), dispose() {} }),
    openTextDocument: async () => ({}),
    fs: {
      readDirectory: async (uri) => {
        const items = await fsp.readdir(uri.fsPath, { withFileTypes: true });
        return items.map((d) => [d.name, d.isDirectory() ? FileType.Directory : FileType.File]);
      },
      stat: async (uri) => {
        const s = await fsp.stat(uri.fsPath);
        return { type: s.isDirectory() ? FileType.Directory : FileType.File, size: s.size, ctime: 0, mtime: 0 };
      },
      readFile: async (uri) => new Uint8Array(await fsp.readFile(uri.fsPath)),
      writeFile: async (uri, data) => { await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fsp.writeFile(uri.fsPath, data); },
      createDirectory: async (uri) => { await fsp.mkdir(uri.fsPath, { recursive: true }); },
      delete: async (uri, o) => { await fsp.rm(uri.fsPath, { recursive: !!o?.recursive, force: true }); },
      rename: async (a, b) => { await fsp.rename(a.fsPath, b.fsPath); },
    },
  },
  commands: {
    registerCommand: (id, handler) => { registeredCommands.set(id, handler); return { dispose() {} }; },
    executeCommand: async (id, ...args) => {
      if (id === 'setContext') { contextKeys.set(args[0], args[1]); return; }
      const h = registeredCommands.get(id);
      return h ? h(...args) : undefined;
    },
  },
};

vscode.__webviewPanels = [];

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, ...rest);
};

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const dist = path.join(repoRoot, 'dist', 'extension.js');
const ext = (await import(pathToFileURL(dist).href)).default ?? Module.createRequire(import.meta.url)(dist);

const context = {
  subscriptions: [],
  secrets: {
    get: async (key) => secretStore.get(key),
    store: async (key, value) => { secretStore.set(key, value); },
    delete: async (key) => { secretStore.delete(key); },
  },
  globalStorageUri: Uri.file(STORAGE),
  extensionUri: Uri.file(repoRoot),
};

console.log('\n激活扩展');
ext.activate(context);
check('activate 未抛异常并注册了 disposable', context.subscriptions.length > 0, true);

console.log('\n命令注册');
const expectedCommands = [
  'mynotes.setup', 'mynotes.createNotesLocation', 'mynotes.newNote', 'mynotes.newNoteInFolder',
  'mynotes.newFolder', 'mynotes.newFolderInFolder', 'mynotes.renameNote', 'mynotes.renameFolder',
  'mynotes.deleteNote', 'mynotes.deleteFolder', 'mynotes.refresh', 'mynotes.listNotes',
  'mynotes.revealInExplorer', 'mynotes.openSettings', 'mynotes.sync',
  'mynotes.setCredential', 'mynotes.clearCredential', 'mynotes.showLog',
];
const missing = expectedCommands.filter((c) => !registeredCommands.has(c));
check('package.json 声明的命令全部已注册', missing, []);
check('配置向导命令已彻底移除，不再残留', registeredCommands.has('mynotes.syncSetup'), false);

console.log('\n设置面板');
await registeredCommands.get('mynotes.openSettings')();
check('打开设置创建了一个 webview 面板', vscode.__webviewPanels.length, 1);

const panel = vscode.__webviewPanels[0];
check('面板标题正确', panel.title, 'MyNotes 设置');
check('渲染出的 HTML 含笔记目录输入框', panel.webview.html.includes('id="notesLocation"'), true);
check('渲染出的 HTML 声明了 CSP', panel.webview.html.includes('Content-Security-Policy'), true);

check('Git 与 WebDAV 两节都渲染在页面中',
  panel.webview.html.includes('id="gitRemoteUrl"') && panel.webview.html.includes('id="webdavUrl"'), true);
check('凭据输入框为 password 类型', panel.webview.html.includes('type="password" id="gitToken"'), true);
check('页面提示了跨 Profile 共享 / 设置同步的行为', panel.webview.html.includes('设置同步'), true);
check('笔记目录字段标注为不跨设备', /id="notesLocation"[\s\S]*?不跨设备/.test(panel.webview.html), true);
check('设备名称字段标注为不跨设备', /id="deviceName"[\s\S]*?不跨设备/.test(panel.webview.html), true);
// 两节按「同步方式」切换显示，初始渲染时都带 hidden，由状态推送决定展开哪一节
check('Git 一节初始为隐藏', panel.webview.html.includes('<section id="gitSection" class="hidden">'), true);
check('WebDAV 一节初始为隐藏', panel.webview.html.includes('<section id="webdavSection" class="hidden">'), true);
check('存在通用 .hidden 样式规则（否则切换不生效）',
  /\.hidden\s*\{[^}]*display:\s*none/.test(panel.webview.html), true);

await panel.webview._receive({ type: 'ready' });
let state = postedMessages.find((m) => m.type === 'state');
check('ready 消息触发状态推送', Boolean(state), true);
check('推送的笔记目录与当前配置一致', state?.notes?.notesLocation, NOTES);
check('推送的同步方式与当前配置一致', state?.sync?.provider, 'none');
check('推送两种后端各自的凭据状态', state?.credentials, { git: false, webdav: false });
check('状态中不含凭据明文', JSON.stringify(state).includes('secret-token'), false);

postedMessages.length = 0;
await panel.webview._receive({ type: 'update', key: 'sync.provider', value: 'git' });
check('update 消息写回配置', effectiveSetting('mynotes.sync.provider'), 'git');
state = postedMessages.find((m) => m.type === 'state');
check('写回后重新推送最新状态', state?.sync?.provider, 'git');
check('仅在用户设置层定义的项写入用户设置', globalSettings.get('mynotes.sync.provider'), 'git');

// 回归：工作区设置优先级高于用户设置，写错层级会让字段「改了自动弹回」
console.log('\n配置写入作用域');
const CHANGED_NOTES = path.join(tmpdir(), 'mynotes-smoke', 'changed');
postedMessages.length = 0;
await panel.webview._receive({ type: 'update', key: 'notesLocation', value: CHANGED_NOTES });
check('已在工作区设置中定义的项写回工作区设置', workspaceSettings.get('mynotes.notesLocation'), CHANGED_NOTES);
check('不会误写到用户设置层', globalSettings.has('mynotes.notesLocation'), false);
state = postedMessages.find((m) => m.type === 'state');
check('改动在推送的状态中即时可见（不会弹回原值）', state?.notes?.notesLocation, CHANGED_NOTES);

// 还原笔记目录，后续用例仍需读取真实目录
await panel.webview._receive({ type: 'update', key: 'notesLocation', value: NOTES });

console.log('\n设置页内联录入凭据');
postedMessages.length = 0;
// 地址为空时凭据无处绑定，应给出提示而不是静默失败
await panel.webview._receive({ type: 'saveCredential', provider: 'webdav', value: 'secret-token' });
let result = postedMessages.find((m) => m.type === 'result');
check('未填地址时保存凭据给出失败提示', result?.ok, false);
check('此时未写入密钥库', secretStore.size, 0);

await panel.webview._receive({ type: 'update', key: 'sync.webdav.url', value: 'https://dav.example.com/dav/' });
postedMessages.length = 0;
await panel.webview._receive({ type: 'saveCredential', provider: 'webdav', value: 'secret-token' });
result = postedMessages.find((m) => m.type === 'result');
check('填好地址后保存成功', result?.ok, true);
check('凭据按「后端+地址」写入密钥库', secretStore.get('mynotes.webdav:https://dav.example.com/dav/'), 'secret-token');
state = postedMessages.find((m) => m.type === 'state');
check('保存后 WebDAV 凭据状态变为已设置', state?.credentials?.webdav, true);
check('Git 凭据不受影响', state?.credentials?.git, false);

postedMessages.length = 0;
await panel.webview._receive({ type: 'clearCredential', provider: 'webdav' });
check('清除后密钥库中已无该项', secretStore.has('mynotes.webdav:https://dav.example.com/dav/'), false);

console.log('\n设置页内联测试连接');
postedMessages.length = 0;
await panel.webview._receive({ type: 'testConnection', provider: 'git' });
result = postedMessages.find((m) => m.type === 'result');
check('未配置仓库地址时测试连接返回失败而非抛异常', result?.ok, false);
check('失败结果定位到 git 区域', result?.target, 'git');

// 本地仓库改由首次同步自动建立，设置页不再提供初始化入口
check('设置页没有初始化仓库的按钮', panel.webview.html.includes('gitInitBtn'), false);
check('说明了仓库会在首次同步时自动建立', panel.webview.html.includes('首次同步会自动执行 git init'), true);

// 还原，避免影响后面「未配置同步时手动同步」的断言
await panel.webview._receive({ type: 'update', key: 'sync.provider', value: 'none' });
postedMessages.length = 0;

await registeredCommands.get('mynotes.openSettings')();
check('重复打开时复用已有面板而非新建', vscode.__webviewPanels.length, 1);
check('复用时调用了 reveal', panel.revealCount, 1);

panel.dispose();
await registeredCommands.get('mynotes.openSettings')();
check('面板关闭后再次打开会重新创建', vscode.__webviewPanels.length, 2);

console.log('\n笔记树');
const provider = vscode.__treeProvider;
await new Promise((r) => setTimeout(r, 50)); // 等待构造函数中的异步 reconfigure
const roots = await provider.getChildren();
const rootNames = roots.map((i) => path.basename(i.uri.fsPath));
// 文件名按当前区域设置排序，故只断言分组与集合，不锁定中英文之间的先后
check('文件夹排在最前', rootNames[0], '工作');
check('过滤掉未配置的扩展名并保留其余文件', rootNames.slice(1).sort(), ['readme.txt', '待办.md']);
check('文件夹项 contextValue 为 folder', roots[0].contextValue, 'folder');
check('笔记项 contextValue 为 note', roots[1].contextValue, 'note');
check('笔记项绑定了打开命令', roots[1].command?.command, 'vscode.open');

const children = await provider.getChildren(roots[0]);
check('子目录内容可读取', children.map((i) => path.basename(i.uri.fsPath)), ['周报.md']);

console.log('\n上下文键');
check('已配置标记为 true', contextKeys.get('mynotes.configured'), true);
check('目录缺失标记为 false', contextKeys.get('mynotes.locationMissing'), false);
check('同步未启用', contextKeys.get('mynotes.syncEnabled'), false);

console.log('\n检索命令');
await registeredCommands.get('mynotes.listNotes')();
check('检索列出全部笔记（含子目录，排除未配置扩展名）',
  (vscode.__lastQuickPick ?? []).map((i) => i.label).sort(),
  ['readme.txt', '周报.md', '待办.md']);

console.log('\n未配置同步时手动同步');
await registeredCommands.get('mynotes.sync')();
check('提示尚未启用同步而非报错', shownMessages.includes('尚未启用同步。'), true);

Module._load = originalLoad;
rmSync(path.join(tmpdir(), 'mynotes-smoke'), { recursive: true, force: true });
console.log(`\n${failures === 0 ? '全部检查通过' : `${failures} 项检查失败`}`);
process.exit(failures === 0 ? 0 : 1);
