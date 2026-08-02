import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../log';

/** 超过该时长仍未释放的锁视为持有进程已异常退出 */
const LOCK_STALE_MS = 10 * 60 * 1000;
/** 大目录同步可能远超过期时长，持锁期间定期续期，避免被其他窗口误判为过期 */
const LOCK_HEARTBEAT_MS = 2 * 60 * 1000;

/**
 * 同步状态的存放目录，固定在用户主目录下。
 *
 * 不能用 ExtensionContext.globalStorageUri：该路径随 VS Code Profile 变化，
 * 换一个 Profile 就等于基线丢失、退化成首次同步，此前删除的笔记会被重新下载回来。
 * 也不放在笔记目录内——否则会被当成笔记显示，还会被 Git 后端一并同步出去。
 */
export function sharedStateDir(): vscode.Uri {
  return vscode.Uri.file(path.join(os.homedir(), '.mynotes'));
}

/** 同一笔记目录在不同窗口、不同 Profile 下必须解析出相同的键 */
export function notesKey(notesLocation: string): string {
  const normalized = path.normalize(notesLocation);
  return createHash('sha256')
    .update(process.platform === 'win32' ? normalized.toLowerCase() : normalized)
    .digest('hex')
    .slice(0, 12);
}

interface LockPayload {
  pid: number;
  device: string;
  startedAt: number;
}

/**
 * 笔记目录级别的跨进程互斥锁。
 *
 * SyncManager 内部的 running 标志只能约束单个窗口，而多开 VS Code 时每个窗口
 * 都是独立的扩展宿主进程：两个窗口同时同步会互相覆盖基线清单，Git 后端还会
 * 直接撞上 index.lock。锁文件放在共享目录，因此对多窗口与多 Profile 同时生效。
 */
export class SyncLock {
  private heartbeat: NodeJS.Timeout | undefined;

  private constructor(
    private readonly file: string,
    private readonly device: string,
  ) {}

  /** 取不到锁时返回 undefined，由调用方决定是跳过本轮还是提示用户 */
  static async acquire(stateDir: vscode.Uri, key: string, device: string): Promise<SyncLock | undefined> {
    await fs.mkdir(stateDir.fsPath, { recursive: true });
    const file = path.join(stateDir.fsPath, `sync-${key}.lock`);

    if (await tryCreateLock(file, device)) {
      return new SyncLock(file, device).startHeartbeat();
    }
    if (!(await breakStaleLock(file))) {
      return undefined;
    }
    // 清理过期锁后重新竞争；再失败说明已被其他窗口抢先，放弃本轮
    return (await tryCreateLock(file, device)) ? new SyncLock(file, device).startHeartbeat() : undefined;
  }

  private startHeartbeat(): this {
    this.heartbeat = setInterval(() => {
      const payload: LockPayload = { pid: process.pid, device: this.device, startedAt: Date.now() };
      void fs.writeFile(this.file, JSON.stringify(payload), 'utf8').catch(() => undefined);
    }, LOCK_HEARTBEAT_MS);
    // 续期不应阻止扩展宿主退出
    this.heartbeat.unref();
    return this;
  }

  async release(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    try {
      await fs.rm(this.file, { force: true });
    } catch (err) {
      log.warn(`释放同步锁失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function tryCreateLock(file: string, device: string): Promise<boolean> {
  const payload: LockPayload = { pid: process.pid, device, startedAt: Date.now() };
  try {
    // wx 由操作系统保证「不存在才创建」的原子性，并发竞争时只有一个进程能成功
    const handle = await fs.open(file, 'wx');
    try {
      await handle.writeFile(JSON.stringify(payload), 'utf8');
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw err;
  }
}

/** 持锁进程崩溃会留下永不释放的锁文件，超过期限则清理，返回是否值得重试 */
async function breakStaleLock(file: string): Promise<boolean> {
  let payload: LockPayload | undefined;
  try {
    payload = JSON.parse(await fs.readFile(file, 'utf8')) as LockPayload;
  } catch {
    // 读不到或内容损坏：可能刚被释放，也可能是残留，一律按可清理处理
    payload = undefined;
  }
  if (payload && Date.now() - payload.startedAt < LOCK_STALE_MS) {
    return false;
  }

  // 先重命名再删除：rename 是原子的，同时判定过期的多个窗口中只有一个会成功，
  // 否则两个窗口可能各自删掉对方刚刚建立的新锁
  const claimed = `${file}.stale-${process.pid}`;
  try {
    await fs.rename(file, claimed);
  } catch {
    return false;
  }
  await fs.rm(claimed, { force: true });
  log.warn('检测到过期的同步锁（上次同步可能异常退出），已清理');
  return true;
}

function syncStatePath(stateDir: vscode.Uri, key: string): string {
  return path.join(stateDir.fsPath, `sync-state-${key}.json`);
}

/**
 * 上次同步完成的时间戳，存放在共享目录而非进程内。
 *
 * 聚焦触发的冷却若只记在内存里，多开窗口时每个窗口各有一份初值为 0 的记录，
 * 在窗口之间来回切换会让冷却完全失效，每次切换都触发一轮同步。
 */
export async function readLastSyncAt(stateDir: vscode.Uri, key: string): Promise<number> {
  try {
    const parsed = JSON.parse(await fs.readFile(syncStatePath(stateDir, key), 'utf8')) as { lastSyncAt?: number };
    return typeof parsed.lastSyncAt === 'number' ? parsed.lastSyncAt : 0;
  } catch {
    return 0;
  }
}

export async function writeLastSyncAt(stateDir: vscode.Uri, key: string, value: number): Promise<void> {
  try {
    await fs.mkdir(stateDir.fsPath, { recursive: true });
    await fs.writeFile(syncStatePath(stateDir, key), JSON.stringify({ lastSyncAt: value }), 'utf8');
  } catch (err) {
    log.warn(`记录同步时间失败：${err instanceof Error ? err.message : String(err)}`);
  }
}
