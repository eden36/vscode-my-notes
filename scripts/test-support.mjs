// 统一隔离文件系统与 VS Code 桩件，测试直接加载生产模块。
import { build } from 'esbuild';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
export class Uri {
  constructor(fsPath) {
    this.fsPath = path.normalize(fsPath);
    this.scheme = 'file';
  }
  static file(value) {
    return new Uri(value);
  }
  static joinPath(base, ...segments) {
    return new Uri(path.join(base.fsPath, ...segments));
  }
  toString() {
    return `file:///${this.fsPath.replace(/\\/g, '/')}`;
  }
  get path() {
    return this.fsPath.replace(/\\/g, '/');
  }
}
export async function testEnvironment() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'syncnotes-test-'));
  const settings = new Map();
  const secrets = new Map();
  const commands = new Map();
  const messages = [];
  const panels = [];
  const inputs = [];
  const choices = [];
  const trees = [];
  const statusBars = [];
  const pending = new Set();
  const errors = [];
  class Emitter {
    listeners = new Set();
    event = callback => {
      this.listeners.add(callback);
      return {
        dispose: () => this.listeners.delete(callback)
      };
    };
    fire(value) {
      for (const listener of this.listeners) {
        const result = listener(value);
        if (result?.then) {
          const promise = Promise.resolve(result).catch(error => errors.push(error)).finally(() => pending.delete(promise));
          pending.add(promise);
        }
      }
    }
    dispose() {
      this.listeners.clear();
    }
  }
  class CancellationTokenSource {
    emitter = new Emitter();
    token = {
      isCancellationRequested: false, onCancellationRequested: this.emitter.event
    };
    cancel() {
      this.token.isCancellationRequested = true;
      this.emitter.fire();
    }
    dispose() {
      this.emitter.dispose();
    }
  }
  const configuration = new Emitter();
  const secretChanges = new Emitter();
  const documents = {
    open: new Emitter(), change: new Emitter(), save: new Emitter(), close: new Emitter()
  };
  const disposable = {
    dispose() {
    }
  };
  const vscode = {
    Uri,
    FileType: {
      File: 1, Directory: 2, SymbolicLink: 64
    },
    CancellationError: class extends Error {
    },
    FileSystemError: class extends Error {
    },
    EventEmitter: Emitter,
    CancellationTokenSource,
    ConfigurationTarget: {
      Global: 1, Workspace: 2, WorkspaceFolder: 3
    },
    StatusBarAlignment: {
      Right: 2
    }, ProgressLocation: {
      Notification: 15
    }, ViewColumn: {
      Active: -1
    },
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    TreeItemCollapsibleState: {
      None: 0, Collapsed: 1
    },
    TreeItem: class {
      constructor(uri, state) {
        this.resourceUri = uri;
        this.collapsibleState = state;
      }
    },
    RelativePattern: class {
      constructor(base, pattern) {
        this.base = base;
        this.pattern = pattern;
      }
    },
    commands: {
      registerCommand: (id, handler) => {
        commands.set(id, handler);
        return {
          dispose: () => commands.delete(id)
        };
      },
      executeCommand: async (id, ...args) => commands.get(id)?.(...args),
    },
    window: {
      createOutputChannel: () => ({
        info() {
        }, warn() {
        }, error() {
        }, trace() {
        }, show() {
        }, dispose() {
        }
      }),
      createStatusBarItem: () => {
        const status = { show() {}, hide() {}, dispose() {} };
        statusBars.push(status);
        return status;
      },
      onDidChangeWindowState: new Emitter().event,
      createTreeView: (_id, options) => {
        trees.push(options.treeDataProvider);
        return {
          reveal: async () => {
          }, dispose() {
          }
        };
      },
      showInformationMessage: async (message) => {
        messages.push(message);
        return choices.shift();
      },
      showWarningMessage: async (message) => {
        messages.push(message);
        return choices.shift();
      },
      showErrorMessage: async (message) => {
        messages.push(message);
        return choices.shift();
      },
      showInputBox: async (options) => {
        const value = inputs.shift();
        if (value !== undefined) {
          const error = await options.validateInput?.(value);
          if (error) {
            throw new Error(error);
          }
        }
        return value;
      },
      showOpenDialog: async () => undefined,
      showQuickPick: async () => undefined,
      showTextDocument: async () => ({}),
      withProgress: async (_options, task) => task({
        report() {
        }
      }, new CancellationTokenSource().token),
      createWebviewPanel: () => {
        const received = new Emitter();
        const disposed = new Emitter();
        const posted = [];
        const panel = {
          webview: {
            html: '', cspSource: 'test-resource:', asWebviewUri: uri => uri,
            onDidReceiveMessage: received.event, postMessage: async (value) => {
              posted.push(value);
            }
          },
          onDidDispose: disposed.event, reveal() {
          }, dispose() {
            disposed.fire();
          }, posted,
          async receive(value) {
            for (const listener of received.listeners) {
              await listener(value);
            }
          },
        };
        panels.push(panel);
        queueMicrotask(() => { void panel.receive({ type: 'ready', requestId: 0 }); });
        return panel;
      },
    },
    workspace: {
      textDocuments: [],
      getConfiguration: () => ({
        get: (key, fallback) => settings.has(key) ? settings.get(key) : fallback,
        inspect: key => ({
          globalValue: settings.get(key)
        }),
        update: async (key, value, target) => {
          if (target !== 1) {
            throw new Error('application 设置必须写入用户级。');
          }
          settings.set(key, value);
          configuration.fire({
            affectsConfiguration: section => section === 'syncnotes'
          });
        },
      }),
      onDidChangeConfiguration: configuration.event,
      onDidOpenTextDocument: documents.open.event,
      onDidChangeTextDocument: documents.change.event,
      onDidSaveTextDocument: documents.save.event,
      onDidCloseTextDocument: documents.close.event,
      createFileSystemWatcher: () => ({
        onDidCreate: () => disposable, onDidDelete: () => disposable, dispose() {
        }
      }),
      openTextDocument: async (uri) => ({
        uri
      }),
      fs: {
        readFile: async (uri) => new Uint8Array(await fs.readFile(uri.fsPath)),
        writeFile: async (uri, content) => {
          await fs.mkdir(path.dirname(uri.fsPath), {
            recursive: true
          });
          await fs.writeFile(uri.fsPath, content);
        },
        readDirectory: async (uri) => (await fs.readdir(uri.fsPath, {
          withFileTypes: true
        })).map(entry => [entry.name, entry.isSymbolicLink() ? 64 : entry.isDirectory() ? 2 : 1]),
        createDirectory: async (uri) => {
          await fs.mkdir(uri.fsPath, {
            recursive: true
          });
        },
        stat: async (uri) => {
          const stat = await fs.stat(uri.fsPath);
          return {
            size: stat.size, type: stat.isDirectory() ? 2 : 1
          };
        },
        rename: async (from, to) => {
          await fs.rename(from.fsPath, to.fsPath);
        },
        delete: async (uri) => {
          await fs.unlink(uri.fsPath);
        },
      },
    },
  };
  const context = {
    subscriptions: [],
    extensionMode: 3,
    globalStorageUri: Uri.file(path.join(root, 'legacy')),
    extensionUri: Uri.file(process.cwd()),
    secrets: {
      get: async (key) => secrets.get(key),
      store: async (key, value) => {
        secrets.set(key, value);
        secretChanges.fire({
          key
        });
      },
      delete: async (key) => {
        secrets.delete(key);
        secretChanges.fire({
          key
        });
      },
      onDidChange: secretChanges.event,
    },
  };
  return {
    root, vscode, context, settings, secrets, commands, messages, panels, inputs, choices, trees, statusBars, documents, errors,
    async flush() {
      while (pending.size) {
        await Promise.all([...pending]);
      }
    },
    async cleanup() {
      const target = path.resolve(root);
      if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('syncnotes-test-')) {
        throw new Error('测试清理路径无效。');
      }
      await fs.rm(target, {
        recursive: true, force: true
      });
    },
  };
}
export async function loadSource(contents, vscode, overrides = {}, globals = {}) {
  const result = await build({
    stdin: {
      contents, resolveDir: process.cwd(), loader: 'ts'
    }, bundle: true,
    write: false, platform: 'node', format: 'cjs', external: ['vscode', 'proper-lockfile']
  });
  const module = {
    exports: {}
  };
  vm.runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, require: name => overrides[name] ?? (name === 'vscode' ? vscode : require(name)),
    process, Buffer, console, URL, URLSearchParams, TextEncoder, TextDecoder, Blob, FormData, Headers, Request, Response, fetch,
    AbortController, AbortSignal, setInterval, clearInterval, setTimeout, clearTimeout,
    ...globals,
  });
  return module.exports;
}
