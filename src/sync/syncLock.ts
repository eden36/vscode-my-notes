import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { lock } from 'proper-lockfile';
import type * as vscode from 'vscode';
/** 原子目录锁由库维护，关闭后忽略在途心跳回调，避免触碰后继租约。 */
export class SyncLock {
  private released = false;
  private compromised: Error | undefined;
  private releaseLock: (() => Promise<void>) | undefined;
  private checkDirectory: (() => void) | undefined;
  private constructor(private readonly owner: string, private readonly token: string) {
  }
  static async acquire(state: vscode.Uri, key: string, device: string, timing = {
    stale: 600000, update: 120000
  }): Promise<SyncLock | undefined> {
    await fsp.mkdir(state.fsPath, {
      recursive: true
    });
    const anchor = path.join(state.fsPath, `sync-${key}`);
    const owner = `${anchor}.owner.json`;
    const lease = new SyncLock(owner, randomUUID());
    let closing = false;
    let created = false;
    let observed: fs.Stats | undefined;
    const filesystem = {
      ...fs,
      mkdir: ((directory: fs.PathLike, callback: (error: NodeJS.ErrnoException | null) => void) => {
        fs.mkdir(directory, error => {
          if (!error) {
            try {
              observed = fs.statSync(directory);
              created = true;
            } catch (inspectionError) {
              callback(inspectionError as NodeJS.ErrnoException);
              return;
            }
          }
          callback(error);
        });
      }) as typeof fs.mkdir,
      stat: ((file: fs.PathLike, callback: (error: NodeJS.ErrnoException | null, stat?: fs.Stats) => void) => {
        fs.stat(file, (error, stat) => {
          if (closing) {
            return;
          }
          observed = stat;
          if (!created && stat) {
            try {
              const payload = JSON.parse(fs.readFileSync(owner, 'utf8')) as {
                pid: number;
              };
              process.kill(payload.pid, 0);
              // 存活进程可能正在休眠，心跳过期仍保持互斥。
              stat.mtime = new Date();
            }
            catch (ownerError) {
              if ((ownerError as NodeJS.ErrnoException).code === 'EPERM') {
                stat.mtime = new Date();
              }
            }
          }
          callback(error, stat);
        });
      }) as typeof fs.stat,
      rmdir: ((directory: fs.PathLike, callback: (error: NodeJS.ErrnoException | null) => void) => {
        try {
          const current = fs.statSync(directory);
          if (observed && (current.ino !== observed.ino || current.birthtimeMs !== observed.birthtimeMs)) {
            callback(Object.assign(new Error('同步锁已被其他进程替换。'), {
              code: 'ELOCKED'
            }));
            return;
          }
          fs.rmdir(directory, callback);
        }
        catch (error) {
          callback(error as NodeJS.ErrnoException);
        }
      }) as typeof fs.rmdir,
    };
    try {
      lease.releaseLock = await lock(anchor, {
        realpath: false, lockfilePath: `${anchor}.lock`, ...timing, retries: 0,
        fs: filesystem,
        onCompromised: error => {
          lease.compromised = error;
        },
      });
      await fsp.writeFile(owner, JSON.stringify({
        token: lease.token, pid: process.pid, device
      }), 'utf8');
      const acquired = fs.statSync(`${anchor}.lock`);
      lease.checkDirectory = () => {
        const current = fs.statSync(`${anchor}.lock`);
        if (current.ino !== acquired.ino || current.birthtimeMs !== acquired.birthtimeMs) {
          throw new Error('同步锁目录已被替换。');
        }
      };
      const release = lease.releaseLock;
      lease.releaseLock = async () => {
        closing = true;
        await release();
      };
      return lease;
    }
    catch (error) {
      await lease.releaseLock?.();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ELOCKED' || code === 'EEXIST') {
        return undefined;
      }
      throw error;
    }
  }
  assertActive(): void {
    if (this.released || this.compromised) {
      throw this.compromised ?? new Error('同步锁已释放。');
    }
    const current = JSON.parse(fs.readFileSync(this.owner, 'utf8')) as {
      token: string;
    };
    if (current.token !== this.token) {
      throw new Error('同步锁租约已失效。');
    }
    this.checkDirectory?.();
  }
  async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;
    await this.releaseLock?.();
  }
}
