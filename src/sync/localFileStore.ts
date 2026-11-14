import { constants } from 'fs';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { conflictFileName } from './conflictName';
import { assertSyncActive, type SyncContext } from './syncProvider';
import { isMissing, writeJsonAtomic } from './stateStore';
import { isInside, isSyncPath } from './syncPath';
import { canonicalFilePath } from './syncIdentity';
import { hashContent, type LocalFile } from './webdav/scanner';
export class LocalChangedError extends Error {
}
/** 同步文件操作集中校验路径、编辑状态和扫描版本。 */
export class LocalFileStore {
  private readonly recoveryFiles: string[] = [];
  constructor(private readonly context: SyncContext) {
  }
  async uri(relative: string): Promise<vscode.Uri> {
    if (!isSyncPath(relative)) {
      throw new Error(`同步路径无效：${relative}`);
    }
    const target = path.join(this.context.root.fsPath, ...relative.split('/'));
    const root = await fs.realpath(this.context.root.fsPath);
    let existing = target;
    while (true) {
      try {
        const resolved = await fs.realpath(existing);
        if (!isInside(root, resolved)) {
          throw new Error(`同步路径超出笔记目录：${relative}`);
        }
        break;
      }
      catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
        existing = path.dirname(existing);
      }
    }
    return vscode.Uri.file(target);
  }
  async read(relative: string): Promise<Uint8Array | undefined> {
    try {
      return await fs.readFile((await this.uri(relative)).fsPath);
    }
    catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
  }
  async check(relative: string, expected: LocalFile | undefined): Promise<void> {
    assertSyncActive(this.context);
    const uri = await this.uri(relative);
    const target = await canonicalFilePath(uri.fsPath);
    const dirtyPaths = await Promise.all(vscode.workspace.textDocuments.filter(document => document.isDirty && document.uri.scheme === 'file')
      .map(document => canonicalFilePath(document.uri.fsPath)));
    const dirty = dirtyPaths.some(file => isInside(target, file));
    if (dirty || await this.context.isEditing?.(relative)) {
      throw new LocalChangedError('笔记正在编辑，已延后覆盖或删除。');
    }
    const current = await this.read(relative);
    if ((current === undefined) !== (expected === undefined) ||
      (current && expected && hashContent(current) !== expected.hash)) {
      throw new LocalChangedError('笔记在扫描后发生变化，已保留当前内容。');
    }
    assertSyncActive(this.context);
  }
  async write(relative: string, content: Uint8Array, expected: LocalFile | undefined): Promise<void> {
    await this.check(relative, expected);
    const target = await this.uri(relative);
    await fs.mkdir(path.dirname(target.fsPath), {
      recursive: true
    });
    const temporary = path.join(path.dirname(target.fsPath), `.syncnotes-tmp-${randomUUID()}`);
    try {
      await fs.writeFile(temporary, content, {
        flag: 'wx'
      });
      await this.check(relative, expected);
      if (expected) {
        const recovery = path.join(this.context.stateUri.fsPath, 'recovery', `${randomUUID()}.bak`);
        await fs.mkdir(path.dirname(recovery), {
          recursive: true
        });
        const metadata = `${recovery}.json`;
        this.recoveryFiles.push(recovery, metadata);
        await writeJsonAtomic(metadata, {
          version: 1, root: this.context.root.fsPath, relativePath: relative,
          hash: expected.hash, backup: path.basename(recovery), createdAt: new Date().toISOString()
        });
        await fs.copyFile(target.fsPath, recovery, constants.COPYFILE_EXCL);
        await this.check(relative, expected);
        await fs.rename(temporary, target.fsPath);
      }
      else {
        // 优先原子发布，不支持硬链接时用排他复制兼容外置盘和网络盘。
        try {
          await fs.link(temporary, target.fsPath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EEXIST') { throw new LocalChangedError('目标文件已由其他操作创建，已保留当前内容。'); }
          if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS'].includes(code ?? '')) { throw error; }
          try { await fs.copyFile(temporary, target.fsPath, constants.COPYFILE_EXCL); }
          catch (copyError) {
            if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') { throw new LocalChangedError('目标文件已由其他操作创建，已保留当前内容。'); }
            throw copyError;
          }
        }
      }
    }
    finally {
      await fs.rm(temporary, {
        force: true
      });
    }
  }
  async delete(relative: string, expected: LocalFile | undefined): Promise<void> {
    await this.check(relative, expected);
    await vscode.workspace.fs.delete(await this.uri(relative), {
      useTrash: true
    });
  }
  async conflict(relative: string, content: Uint8Array): Promise<vscode.Uri> {
    const directory = path.posix.dirname(relative);
    const name = conflictFileName(path.posix.basename(relative), this.context.deviceName, new Date());
    for (let index = 0;index < 100;index++) {
      const extension = path.extname(name);
      const stem = extension ? name.slice(0, -extension.length) : name;
      const candidate = path.posix.join(directory, index ? `${stem}-${index + 1}${extension}` : name);
      try {
        assertSyncActive(this.context);
        const uri = await this.uri(candidate);
        await fs.mkdir(path.dirname(uri.fsPath), {
          recursive: true
        });
        await fs.writeFile(uri.fsPath, content, {
          flag: 'wx'
        });
        return uri;
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    }
    throw new Error('冲突副本名称持续被占用，无法创建副本。');
  }
  /** 基线提交后清理本任务备份，崩溃遗留备份保留以供恢复。 */
  async finalize(): Promise<void> {
    for (const file of this.recoveryFiles.splice(0)) {
      await fs.rm(file, {
        force: true
      });
    }
  }
}
