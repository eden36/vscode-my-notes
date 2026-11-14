import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { notesKey } from './sharedState';
import { isMissing, writeJsonAtomic } from './stateStore';
import { isInside } from './syncPath';
import { canonicalFilePath } from './syncIdentity';
interface EditorRecord {
  version: 1;
  instance: string;
  pid: number;
  startedAt: number;
  updatedAt: number;
  root: string;
  dirty: string[];
}
/** 各窗口有序发布编辑状态，状态不确定时延后危险操作。 */
export class EditorState implements vscode.Disposable {
  private readonly instance = randomUUID();
  private readonly startedAt = Date.now();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timer: NodeJS.Timeout;
  private queue: Promise<void> = Promise.resolve();
  private failure: unknown;
  private disposed = false;
  private file: string | undefined;
  private root: string | undefined;
  private lastSnapshot = '';
  private lastQueuedAt = 0;
  constructor(private readonly state: vscode.Uri, private readonly onEdit: () => void) {
    const update = () => this.publish();
    const change = vscode.workspace.onDidChangeTextDocument?.(async event => {
      const root = this.root;
      if (root && event.document.isDirty && event.document.uri.scheme === 'file') {
        try {
          const file = await canonicalFilePath(event.document.uri.fsPath);
          if (root === this.root && isInside(root, file)) { this.onEdit(); }
        } catch { this.onEdit(); }
      }
      update();
    });
    for (const event of [change, vscode.workspace.onDidOpenTextDocument?.(update),
      vscode.workspace.onDidSaveTextDocument(update), vscode.workspace.onDidCloseTextDocument?.(update)]) {
      if (event) {
        this.disposables.push(event);
      }
    }
    this.timer = setInterval(update, 30000);
    this.timer.unref();
  }
  async setRoot(root: string | undefined): Promise<void> {
    const previous = this.file;
    this.root = root;
    this.file = root ? path.join(this.state.fsPath, `editor-${notesKey(root)}-${this.instance}.json`) : undefined;
    this.lastSnapshot = '';
    this.queue = this.queue.then(async () => {
      if (previous) {
        await fs.rm(previous, {
          force: true
        });
      }
    }).catch(error => {
      this.failure = error;
    });
    this.publish();
    await this.queue;
  }
  private publish(): void {
    if (this.disposed || !this.file || !this.root) {
      return;
    }
    const file = this.file;
    const root = this.root;
    const dirtyPaths = vscode.workspace.textDocuments.filter(document => document.isDirty && document.uri.scheme === 'file')
      .map(document => document.uri.fsPath);
    const snapshot = JSON.stringify([root, dirtyPaths]);
    if (snapshot === this.lastSnapshot && Date.now() - this.lastQueuedAt < 25000) {
      return;
    }
    this.lastSnapshot = snapshot;
    this.lastQueuedAt = Date.now();
    this.queue = this.queue.then(async () => {
      const dirty: string[] = [];
      for (const filePath of dirtyPaths) {
        const resolved = await canonicalFilePath(filePath);
        if (isInside(root, resolved)) {
          dirty.push(path.relative(root, resolved).split(path.sep).join('/'));
        }
      }
      const record: EditorRecord = {
        version: 1, instance: this.instance, pid: process.pid, startedAt: this.startedAt,
        updatedAt: Date.now(), root, dirty
      };
      await writeJsonAtomic(file, record);
      this.failure = undefined;
    }).catch(error => {
      this.failure = error;
    });
  }
  async isEditing(relative: string): Promise<boolean> {
    this.publish();
    await this.queue;
    if (this.failure || !this.root) {
      return true;
    }
    const prefix = `editor-${notesKey(this.root)}-`;
    for (const name of await fs.readdir(this.state.fsPath)) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) {
        continue;
      }
      const file = path.join(this.state.fsPath, name);
      try {
        const record = JSON.parse(await fs.readFile(file, 'utf8')) as EditorRecord;
        if (!Number.isInteger(record.pid) || record.pid <= 0) {
          return true;
        }
        try {
          process.kill(record.pid, 0);
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            await fs.rm(file, {
              force: true
            });
            continue;
          }
          return true;
        }
        if (record.version !== 1 || record.root !== this.root || !Array.isArray(record.dirty) ||
          !record.dirty.every(value => typeof value === 'string') || !Number.isFinite(record.updatedAt)) {
          return true;
        }
        if (record.dirty.includes(relative)) {
          return true;
        }
      }
      catch (error) {
        if (!isMissing(error)) {
          return true;
        }
      }
    }
    return false;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.timer);
    this.disposables.forEach(disposable => disposable.dispose());
    await this.queue;
    if (this.file) {
      await fs.rm(this.file, {
        force: true
      });
    }
  }
}
