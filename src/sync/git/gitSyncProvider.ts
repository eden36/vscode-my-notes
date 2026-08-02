import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import simpleGit, { CheckRepoActions, type SimpleGit } from 'simple-git';
import * as vscode from 'vscode';
import { getSyncConfig } from '../../config';
import { log } from '../../log';
import { exists } from '../../notes/noteFs';
import { resolveConflictUri } from '../conflict';
import { getSecretFor } from '../secrets';
import {
  emptyResult,
  SyncConfigError,
  type ConflictInfo,
  type SyncContext,
  type SyncProvider,
  type SyncResult,
} from '../syncProvider';
import { buildAskpassEnv, isSshRemote } from './askpass';
import { parseUnmergedStages, STAGE_LOCAL, STAGE_REMOTE } from './unmergedStages';

const execFileAsync = promisify(execFile);

/**
 * 每次调用 git 都强制的仓库配置：
 * - core.quotepath=false 让中文文件名原样输出，否则会被转义成 \345\267\245 形式
 * - core.autocrlf=false 保持字节不变，避免跨设备因换行符改写产生虚假差异
 */
const GIT_CONFIG = ['core.quotepath=false', 'core.autocrlf=false', 'core.safecrlf=false'];

const PUSH_MAX_ATTEMPTS = 2;

/**
 * simple-git 会拦下 env 里一切可能让 git 转去执行外部命令的变量。这里的来源只有
 * 两处：用户自己机器上的配置（SSH、代理、git 路径前缀），以及本扩展生成的 askpass
 * 壳脚本，都不是不可信输入，因此逐项放行。
 *
 * 其中 allowUnsafeAskPass 是必开项——GIT_ASKPASS 正是本扩展用来传递访问令牌的方式，
 * 不放行的话，凡是走 HTTPS + 令牌的同步都会被直接拦下。
 */
const UNSAFE_ENV_ALLOWED = {
  allowUnsafeAskPass: true,
  allowUnsafeConfigEnvCount: true,
  allowUnsafeConfigPaths: true,
  allowUnsafeDiffExternal: true,
  allowUnsafeGitProxy: true,
  allowUnsafePager: true,
  allowUnsafeSshCommand: true,
  allowUnsafeTemplateDir: true,
} as const;

/** 同步全程使用 -m / --no-edit，绝不能让 git 停下来等编辑器或分页器 */
const INTERACTIVE_ENV_KEYS = ['EDITOR', 'VISUAL', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'PAGER', 'GIT_PAGER'];

export class GitSyncProvider implements SyncProvider {
  readonly id = 'git' as const;
  readonly displayName = 'Git 仓库';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async validate(): Promise<void> {
    const cfg = getSyncConfig();
    if (!cfg.git.remoteUrl) {
      throw new SyncConfigError('未配置 Git 远程仓库地址。');
    }
    await assertGitAvailable();
  }

  /** ls-remote 不需要本地仓库，最适合用来单独验证地址与凭据是否可用 */
  async testConnection(): Promise<string> {
    const cfg = getSyncConfig();
    await this.validate();

    const env = await this.buildEnv(cfg.git.remoteUrl);
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('git', ['ls-remote', '--heads', cfg.git.remoteUrl, cfg.git.branch], {
        env,
        timeout: 30_000,
      }));
    } catch (err) {
      throw new SyncConfigError(`无法连接远程仓库：${extractGitError(err)}`);
    }

    return stdout.trim()
      ? `连接成功，远端已存在分支「${cfg.git.branch}」。`
      : `连接成功，但远端尚无分支「${cfg.git.branch}」，首次同步时会自动创建。`;
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const cfg = getSyncConfig();
    const result = emptyResult();
    const git = await this.createGit(ctx.root.fsPath, cfg.git.remoteUrl);

    ctx.report('检查仓库状态');
    // 无条件先查归属：笔记目录一律不得位于其他 Git 仓库内部，哪怕它自己已经是
    // 一个仓库根（嵌套仓库同样拒绝——外层仓库会把笔记目录记成一个 gitlink，
    // 两边的历史互相干扰，笔记内容看似已提交实则没有）
    await assertNotInsideAnotherRepo(ctx.root.fsPath);

    // 到这里已确认不在别人的仓库里，笔记目录自己还不是仓库根就地建一个
    if (!(await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT))) {
      ctx.report('初始化本地仓库');
      await this.initRepository(git, ctx.root, cfg.git.branch);
    }

    await this.ensureRemote(git, cfg.git.remoteUrl);
    await this.ensureIdentity(git, cfg.git.userName, cfg.git.userEmail);

    const branch = await this.currentBranch(git);
    if (branch !== cfg.git.branch) {
      throw new SyncConfigError(
        `笔记仓库当前分支为「${branch}」，与配置的同步分支「${cfg.git.branch}」不一致。` +
          `请修改设置 mynotes.sync.git.branch，或将仓库切换到「${cfg.git.branch}」分支。`,
      );
    }

    throwIfCancelled(ctx);

    ctx.report('提交本地改动');
    result.uploaded.push(...(await this.commitLocalChanges(git, ctx, cfg.git.commitMessageTemplate)));

    for (let attempt = 1; attempt <= PUSH_MAX_ATTEMPTS; attempt++) {
      throwIfCancelled(ctx);

      ctx.report('拉取远端改动');
      await git.fetch(['origin', '--prune']);

      const remoteRef = `refs/remotes/origin/${branch}`;
      if (await this.refExists(git, remoteRef)) {
        const before = await this.headSha(git);

        ctx.report('合并远端改动');
        const conflicts = await this.mergeRemote(git, ctx, `origin/${branch}`);
        result.conflicts.push(...conflicts);

        const after = await this.headSha(git);
        if (before && after && before !== after) {
          result.downloaded.push(...(await this.diffFiles(git, before, after)));
        }
      }

      throwIfCancelled(ctx);
      ctx.report('推送到远端');
      try {
        await git.push('origin', branch);
        return result;
      } catch (err) {
        if (attempt >= PUSH_MAX_ATTEMPTS || !isNonFastForward(err)) {
          throw err;
        }
        log.warn('推送被拒绝（远端有新提交），重新拉取后重试');
      }
    }

    return result;
  }

  /**
   * 在笔记目录就地建立仓库：init、切到同步分支、补一份 .gitignore。
   * origin 与提交身份交给随后的 ensureRemote / ensureIdentity 统一处理。
   * 调用前 sync() 已确认该目录不在其他仓库内部。
   */
  private async initRepository(git: SimpleGit, root: vscode.Uri, branch: string): Promise<void> {
    await git.init();
    // 跨设备同步时统一换行符处理，避免因 CRLF 改写产生整文件差异
    await git.addConfig('core.autocrlf', 'false', false, 'local');
    await git.addConfig('core.quotepath', 'false', false, 'local');
    // -B 在分支已存在时切换、不存在时创建，对尚无提交的空仓库同样有效
    await git.raw(['checkout', '-B', branch]);
    await ensureGitignore(root);

    log.info(`已在 ${root.fsPath} 初始化 Git 仓库，分支 ${branch}`);
  }

  private async createGit(baseDir: string, remoteUrl: string): Promise<SimpleGit> {
    const git = simpleGit({
      baseDir,
      binary: 'git',
      maxConcurrentProcesses: 1,
      config: GIT_CONFIG,
      unsafe: UNSAFE_ENV_ALLOWED,
    });
    git.env(await this.buildEnv(remoteUrl));
    return git;
  }

  /** 组装 git 子进程的环境变量：HTTPS 远端注入 askpass 凭据，SSH 远端沿用 ssh-agent */
  private async buildEnv(remoteUrl: string): Promise<Record<string, string>> {
    const base: Record<string, string> = {
      ...(process.env as Record<string, string>),
      // 缺凭据时让 git 直接失败，而不是卡在终端提示上导致同步永远挂起
      GIT_TERMINAL_PROMPT: '0',
    };
    for (const key of INTERACTIVE_ENV_KEYS) {
      delete base[key];
    }

    if (isSshRemote(remoteUrl)) {
      return base;
    }

    const password = await getSecretFor(this.context, 'git');
    if (!password) {
      return base;
    }

    // 多数托管平台在使用访问令牌时忽略用户名。需要指定时可写成
    // https://用户名@host/repo.git，这里会从地址中取出。
    const username = extractUserFromUrl(remoteUrl) || 'token';
    return { ...base, ...(await buildAskpassEnv(this.context, { username, password })) };
  }

  private async ensureRemote(git: SimpleGit, remoteUrl: string): Promise<void> {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin');
    if (!origin) {
      await git.addRemote('origin', remoteUrl);
      log.info(`已添加远程仓库 origin：${remoteUrl}`);
      return;
    }
    if (origin.refs.push !== remoteUrl && origin.refs.fetch !== remoteUrl) {
      // 配置是唯一事实来源，地址变更时同步更新仓库
      await git.remote(['set-url', 'origin', remoteUrl]);
      log.info(`已将 origin 地址更新为 ${remoteUrl}`);
    }
  }

  private async ensureIdentity(git: SimpleGit, userName: string, userEmail: string): Promise<void> {
    if (userName) {
      await git.addConfig('user.name', userName, false, 'local');
    }
    if (userEmail) {
      await git.addConfig('user.email', userEmail, false, 'local');
    }
  }

  /** symbolic-ref 在尚无提交的空仓库上同样可用，rev-parse 则会失败 */
  private async currentBranch(git: SimpleGit): Promise<string> {
    try {
      return (await git.raw(['symbolic-ref', '--short', 'HEAD'])).trim();
    } catch {
      throw new SyncConfigError('笔记仓库处于分离 HEAD 状态，请先切换到同步分支后再试。');
    }
  }

  private async headSha(git: SimpleGit): Promise<string | undefined> {
    try {
      return (await git.raw(['rev-parse', 'HEAD'])).trim();
    } catch {
      return undefined; // 尚无任何提交
    }
  }

  private async refExists(git: SimpleGit, ref: string): Promise<boolean> {
    try {
      // 不能加 --quiet：它会连 stderr 一起抑制，simple-git 据此判定命令成功，
      // 于是任何 ref 都被认为存在，首次同步就会去合并一个并不存在的远端分支
      const sha = await git.raw(['rev-parse', '--verify', ref]);
      return sha.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async commitLocalChanges(git: SimpleGit, ctx: SyncContext, template: string): Promise<string[]> {
    await git.add(['-A']);
    const staged = splitNulList(await git.raw(['diff', '--cached', '--name-only', '-z']));
    if (staged.length === 0) {
      return [];
    }

    const message = template
      .replace(/\{device\}/g, ctx.deviceName)
      .replace(/\{datetime\}/g, new Date().toLocaleString())
      .replace(/\{count\}/g, String(staged.length));

    await git.commit(message);
    log.info(`已提交 ${staged.length} 个文件的本地改动`);
    return staged;
  }

  /**
   * 合并远端分支。冲突时保留本地版本，并把远端版本另存为冲突副本，
   * 然后完成这次合并提交——绝不让仓库停留在冲突中间态。
   */
  private async mergeRemote(git: SimpleGit, ctx: SyncContext, remoteBranch: string): Promise<ConflictInfo[]> {
    try {
      // 本地 init、远端已有内容的情形属于无关历史，对笔记场景应当直接合并
      await git.raw(['merge', remoteBranch, '--no-edit', '--allow-unrelated-histories']);
      return [];
    } catch (err) {
      const conflicted = await this.readUnmergedStages(git);
      if (conflicted.size === 0) {
        throw err; // 并非冲突导致的失败，交给上层处理
      }
      log.warn(`合并产生 ${conflicted.size} 处冲突，开始逐个保留双方内容`);
      const conflicts = await this.resolveConflicts(git, ctx, conflicted);
      await git.add(['-A']);
      await git.raw(['commit', '--no-edit']);
      return conflicts;
    }
  }

  /** 读取未合并文件及其在暂存区保留的阶段 */
  private async readUnmergedStages(git: SimpleGit): Promise<Map<string, Set<number>>> {
    return parseUnmergedStages(await git.raw(['ls-files', '-u', '-z']));
  }

  private async resolveConflicts(
    git: SimpleGit,
    ctx: SyncContext,
    conflicted: Map<string, Set<number>>,
  ): Promise<ConflictInfo[]> {
    const conflicts: ConflictInfo[] = [];
    const cwd = ctx.root.fsPath;

    for (const [relativePath, stages] of conflicted) {
      const hasLocal = stages.has(STAGE_LOCAL);
      const hasRemote = stages.has(STAGE_REMOTE);
      const target = vscode.Uri.joinPath(ctx.root, ...relativePath.split('/'));

      if (hasLocal && hasRemote) {
        // 双方都改了：本地版本留在原处，远端版本另存为副本
        const copyUri = await resolveConflictUri(ctx.root, relativePath, ctx.deviceName);
        await vscode.workspace.fs.writeFile(copyUri, await this.showBuffer(cwd, `:3:${relativePath}`));
        await git.raw(['checkout', '--ours', '--', relativePath]);
        conflicts.push({
          relativePath,
          copyUri,
          description: '本地与远端都有修改，已保留本地版本，远端版本另存为副本',
        });
      } else if (hasLocal && !hasRemote) {
        // 远端删除、本地修改：保留本地内容，下次推送会把它恢复到远端
        await git.raw(['checkout', '--ours', '--', relativePath]);
        conflicts.push({
          relativePath,
          copyUri: target,
          description: '远端已删除但本地有修改，已保留本地版本',
        });
      } else if (!hasLocal && hasRemote) {
        // 本地删除、远端修改：恢复远端内容，避免丢掉对方的改动
        await vscode.workspace.fs.writeFile(target, await this.showBuffer(cwd, `:3:${relativePath}`));
        conflicts.push({
          relativePath,
          copyUri: target,
          description: '本地已删除但远端有修改，已恢复远端版本',
        });
      }
    }

    return conflicts;
  }

  /** 按字节读取对象内容，避免图片等二进制附件在文本解码中被破坏 */
  private async showBuffer(cwd: string, spec: string): Promise<Uint8Array> {
    const { stdout } = await execFileAsync('git', ['show', spec], {
      cwd,
      encoding: 'buffer',
      maxBuffer: 128 * 1024 * 1024,
    });
    return stdout as unknown as Uint8Array;
  }

  private async diffFiles(git: SimpleGit, from: string, to: string): Promise<string[]> {
    return splitNulList(await git.raw(['diff', '--name-only', '-z', from, to]));
  }
}

function splitNulList(raw: string): string[] {
  return raw.split('\0').filter((entry) => entry.length > 0);
}

function isNonFastForward(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return message.includes('non-fast-forward') || message.includes('fetch first') || message.includes('rejected');
}

/** 从 https://user@host/repo.git 形式的地址中取出用户名 */
function extractUserFromUrl(remoteUrl: string): string | undefined {
  try {
    const parsed = new URL(remoteUrl);
    return parsed.username || undefined;
  } catch {
    return undefined;
  }
}

function throwIfCancelled(ctx: SyncContext): void {
  if (ctx.token.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
}

/**
 * 笔记目录一律不得位于其他 Git 仓库内部，否则拒绝同步。
 *
 * 必须从「父目录」查起，而不是笔记目录自身：笔记目录若已经是一个仓库根，
 * 在它内部执行 rev-parse 只会得到它自己，外层仓库根本看不见，嵌套的情形就被漏掉了。
 *
 * 拒绝的理由有两层：笔记目录尚未初始化时，后续操作会落到外层仓库上，把那个仓库的
 * 内容当作笔记提交推送、还会改掉它的 origin；笔记目录已是独立仓库时虽不会误伤外层，
 * 但外层会把它记成一个 gitlink，笔记内容看似已提交实则没有进入任何一方的版本控制。
 */
async function assertNotInsideAnotherRepo(notesPath: string): Promise<void> {
  const parent = path.dirname(notesPath);
  if (parent === notesPath) {
    return; // 已经是磁盘根目录，没有更外层了
  }

  let owner = '';
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: parent });
    owner = stdout.trim();
  } catch {
    return; // 父目录不在任何仓库内，这才是笔记目录应有的位置
  }

  if (owner) {
    throw new SyncConfigError(
      `笔记目录「${notesPath}」位于 Git 仓库「${path.normalize(owner)}」内部，无法进行 Git 同步。` +
        '笔记仓库必须与其他仓库彼此独立，请把笔记目录移到该仓库之外。',
    );
  }
}

/** 新建的笔记仓库补一份 .gitignore，挡掉各系统自动生成的杂项文件 */
async function ensureGitignore(root: vscode.Uri): Promise<void> {
  const uri = vscode.Uri.joinPath(root, '.gitignore');
  if (await exists(uri)) {
    return;
  }
  const content = ['.DS_Store', 'Thumbs.db', 'desktop.ini', ''].join('\n');
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}

export async function assertGitAvailable(): Promise<void> {
  try {
    await execFileAsync('git', ['--version']);
  } catch {
    throw new SyncConfigError('未检测到 git 命令，请先安装 Git 并确保它在 PATH 中。');
  }
}

/** git 的有效报错在 stderr 里，Error.message 会混入完整命令行，这里只取要点 */
function extractGitError(err: unknown): string {
  const stderr = (err as { stderr?: string })?.stderr;
  const text = (typeof stderr === 'string' && stderr.trim()) || (err instanceof Error ? err.message : String(err));
  return text.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 3).join('；');
}
