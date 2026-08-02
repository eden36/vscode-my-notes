// 用真实 git 仓库验证 GitSyncProvider 依赖的命令语义与冲突处理流程。
// 覆盖：双方修改、一方删除一方修改、新增/新增、中文文件名、无关历史合并。
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import Module from 'module';
import { build } from 'esbuild';
import simpleGit, { CheckRepoActions } from 'simple-git';

const ROOT = join(tmpdir(), 'mynotes-git-scenarios');
const CONFIG = ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@t'];

function git(cwd, args, opts = {}) {
  return execFileSync('git', [...CONFIG, ...args], { cwd, encoding: opts.buffer ? 'buffer' : 'utf8' });
}
function tryGit(cwd, args) {
  try { return { ok: true, out: git(cwd, args) }; }
  catch (e) { return { ok: false, out: String(e.stdout ?? '') + String(e.stderr ?? '') }; }
}

// 与 src/sync/git/unmergedStages.ts 保持一致的解析实现
function parseUnmergedStages(raw) {
  const stages = new Map();
  for (const entry of raw.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const stage = Number(entry.slice(0, tab).trim().split(/\s+/)[2]);
    const p = entry.slice(tab + 1);
    if (!p || !Number.isInteger(stage) || stage < 1 || stage > 3) continue;
    const set = stages.get(p) ?? new Set();
    set.add(stage);
    stages.set(p, set);
  }
  return stages;
}

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

const REMOTE = join(ROOT, 'remote.git');
const A = join(ROOT, 'deviceA');
const B = join(ROOT, 'deviceB');

git(ROOT, ['init', '--bare', '-b', 'main', REMOTE]);
git(ROOT, ['clone', REMOTE, A]);
git(ROOT, ['clone', REMOTE, B]);

// 建立共同基线，含中文文件名
writeFileSync(join(A, '工作日志.md'), '第一行\n');
writeFileSync(join(A, 'shared.md'), 'base\n');
writeFileSync(join(A, 'onlyA-deletes.md'), 'base\n');
writeFileSync(join(A, 'onlyB-deletes.md'), 'base\n');
git(A, ['add', '-A']);
git(A, ['commit', '-m', 'base']);
git(A, ['push', 'origin', 'main']);
git(B, ['pull', 'origin', 'main']);

console.log('\n场景 1：双方修改同一文件（含中文文件名）');
{
  writeFileSync(join(A, '工作日志.md'), 'A 的版本\n');
  git(A, ['add', '-A']); git(A, ['commit', '-m', 'A']); git(A, ['push', 'origin', 'main']);

  writeFileSync(join(B, '工作日志.md'), 'B 的版本\n');
  git(B, ['add', '-A']); git(B, ['commit', '-m', 'B']);
  git(B, ['fetch', 'origin', '--prune']);

  const merge = tryGit(B, ['merge', 'origin/main', '--no-edit', '--allow-unrelated-histories']);
  check('合并应产生冲突', merge.ok, false);

  const stages = parseUnmergedStages(git(B, ['ls-files', '-u', '-z']));
  check('中文路径未被转义', [...stages.keys()], ['工作日志.md']);
  check('保留本地与远端两个阶段', [...(stages.get('工作日志.md') ?? [])].sort(), [1, 2, 3]);

  // 按 provider 的做法：取阶段 3 存为副本，再把本地版本放回原处
  const remoteContent = git(B, ['show', ':3:工作日志.md'], { buffer: true });
  writeFileSync(join(B, '工作日志.conflict-B-20260802-171530.md'), remoteContent);
  git(B, ['checkout', '--ours', '--', '工作日志.md']);
  git(B, ['add', '-A']);
  git(B, ['commit', '--no-edit']);

  check('本地版本保持不变', readFileSync(join(B, '工作日志.md'), 'utf8'), 'B 的版本\n');
  check('远端版本存入冲突副本', readFileSync(join(B, '工作日志.conflict-B-20260802-171530.md'), 'utf8'), 'A 的版本\n');
  check('合并已完成，无残留冲突', git(B, ['ls-files', '-u', '-z']), '');

  git(B, ['push', 'origin', 'main']);
  git(A, ['pull', 'origin', 'main']);
  check('A 拉取后也能看到冲突副本', existsSync(join(A, '工作日志.conflict-B-20260802-171530.md')), true);
}

console.log('\n场景 2：远端删除、本地修改');
{
  unlinkSync(join(A, 'onlyA-deletes.md'));
  git(A, ['add', '-A']); git(A, ['commit', '-m', 'A 删除']); git(A, ['push', 'origin', 'main']);

  writeFileSync(join(B, 'onlyA-deletes.md'), 'B 改过了\n');
  git(B, ['add', '-A']); git(B, ['commit', '-m', 'B 修改']);
  git(B, ['fetch', 'origin', '--prune']);
  const merge = tryGit(B, ['merge', 'origin/main', '--no-edit', '--allow-unrelated-histories']);
  check('合并应产生冲突', merge.ok, false);

  const stages = parseUnmergedStages(git(B, ['ls-files', '-u', '-z']));
  check('只保留本地阶段（缺阶段 3 表示远端已删）', [...(stages.get('onlyA-deletes.md') ?? [])].sort(), [1, 2]);

  git(B, ['checkout', '--ours', '--', 'onlyA-deletes.md']);
  git(B, ['add', '-A']);
  git(B, ['commit', '--no-edit']);
  check('本地修改被保留', readFileSync(join(B, 'onlyA-deletes.md'), 'utf8'), 'B 改过了\n');

  git(B, ['push', 'origin', 'main']);
  git(A, ['pull', 'origin', 'main']);
  check('A 端文件被恢复', existsSync(join(A, 'onlyA-deletes.md')), true);
}

console.log('\n场景 3：本地删除、远端修改');
{
  writeFileSync(join(A, 'onlyB-deletes.md'), 'A 改过了\n');
  git(A, ['add', '-A']); git(A, ['commit', '-m', 'A 修改']); git(A, ['push', 'origin', 'main']);

  unlinkSync(join(B, 'onlyB-deletes.md'));
  git(B, ['add', '-A']); git(B, ['commit', '-m', 'B 删除']);
  git(B, ['fetch', 'origin', '--prune']);
  const merge = tryGit(B, ['merge', 'origin/main', '--no-edit', '--allow-unrelated-histories']);
  check('合并应产生冲突', merge.ok, false);

  const stages = parseUnmergedStages(git(B, ['ls-files', '-u', '-z']));
  check('只保留远端阶段（缺阶段 2 表示本地已删）', [...(stages.get('onlyB-deletes.md') ?? [])].sort(), [1, 3]);

  // checkout --ours 在缺少阶段 2 时无法使用，改为写回阶段 3 的内容
  const oursFails = tryGit(B, ['checkout', '--ours', '--', 'onlyB-deletes.md']);
  check('checkout --ours 在此情形下不可用', oursFails.ok, false);

  writeFileSync(join(B, 'onlyB-deletes.md'), git(B, ['show', ':3:onlyB-deletes.md'], { buffer: true }));
  git(B, ['add', '-A']);
  git(B, ['commit', '--no-edit']);
  check('远端修改被恢复', readFileSync(join(B, 'onlyB-deletes.md'), 'utf8'), 'A 改过了\n');
  check('合并已完成', git(B, ['ls-files', '-u', '-z']), '');
  git(B, ['push', 'origin', 'main']);
}

console.log('\n场景 4：双方各自新增同名文件（无基线阶段）');
{
  git(A, ['pull', 'origin', 'main']);
  writeFileSync(join(A, 'both-new.md'), 'A 新建\n');
  git(A, ['add', '-A']); git(A, ['commit', '-m', 'A 新建']); git(A, ['push', 'origin', 'main']);

  writeFileSync(join(B, 'both-new.md'), 'B 新建\n');
  git(B, ['add', '-A']); git(B, ['commit', '-m', 'B 新建']);
  git(B, ['fetch', 'origin', '--prune']);
  tryGit(B, ['merge', 'origin/main', '--no-edit', '--allow-unrelated-histories']);

  const stages = parseUnmergedStages(git(B, ['ls-files', '-u', '-z']));
  check('新增/新增只有阶段 2 和 3', [...(stages.get('both-new.md') ?? [])].sort(), [2, 3]);

  writeFileSync(join(B, 'both-new.conflict.md'), git(B, ['show', ':3:both-new.md'], { buffer: true }));
  git(B, ['checkout', '--ours', '--', 'both-new.md']);
  git(B, ['add', '-A']); git(B, ['commit', '--no-edit']);
  check('本地新建内容保留', readFileSync(join(B, 'both-new.md'), 'utf8'), 'B 新建\n');
  check('远端新建内容存入副本', readFileSync(join(B, 'both-new.conflict.md'), 'utf8'), 'A 新建\n');
  git(B, ['push', 'origin', 'main']);
}

console.log('\n场景 5：本地 init 与已有内容的远端合并（无关历史）');
{
  const C = join(ROOT, 'deviceC');
  mkdirSync(C);
  git(C, ['init', '-b', 'main']);
  writeFileSync(join(C, 'local-only.md'), 'C 本地\n');
  git(C, ['add', '-A']); git(C, ['commit', '-m', 'C 首次']);
  git(C, ['remote', 'add', 'origin', REMOTE]);
  git(C, ['fetch', 'origin', '--prune']);

  const withoutFlag = tryGit(C, ['merge', 'origin/main', '--no-edit']);
  check('不加 --allow-unrelated-histories 会失败', withoutFlag.ok, false);

  const withFlag = tryGit(C, ['merge', 'origin/main', '--no-edit', '--allow-unrelated-histories']);
  check('加上该参数后合并成功', withFlag.ok, true);
  check('本地文件保留', existsSync(join(C, 'local-only.md')), true);
  check('远端文件合入', existsSync(join(C, '工作日志.md')), true);
}

console.log('\n场景 6：符号引用与暂存清单');
{
  check('symbolic-ref 可读出分支名', git(B, ['symbolic-ref', '--short', 'HEAD']).trim(), 'main');
  writeFileSync(join(B, '带 空格 和#号.md'), 'x\n');
  git(B, ['add', '-A']);
  const staged = git(B, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
  check('特殊字符文件名原样输出', staged, ['带 空格 和#号.md']);
  git(B, ['commit', '-m', 'cleanup']);
}

console.log('\n场景 7：笔记目录位于另一个仓库内部');
{
  // 笔记目录没有自己的 .git，却落在某个项目仓库的工作树内时，默认的 checkIsRepo()
  // 会一路向上找到那个项目仓库并把它当成笔记仓库，随后的 add -A / commit / push
  // 会把项目源码推到笔记远端，remote set-url 还会改掉它的 origin
  const outer = join(ROOT, 'outer-project');
  mkdirSync(outer, { recursive: true });
  git(outer, ['init', '-b', 'master', '.']);
  writeFileSync(join(outer, 'source.ts'), 'export const x = 1;\n');
  git(outer, ['add', '-A']);
  git(outer, ['commit', '-m', 'project']);

  const nested = join(outer, 'notes');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, '笔记.md'), '内容\n');

  check('子目录会向上解析到外层仓库', git(nested, ['rev-parse', '--show-toplevel']).trim().endsWith('outer-project'), true);
  check('默认的工作树判断把外层仓库当成了笔记仓库',
    await simpleGit({ baseDir: nested }).checkIsRepo(CheckRepoActions.IN_TREE), true);
  check('仓库根判断正确识别出笔记目录不是仓库',
    await simpleGit({ baseDir: nested }).checkIsRepo(CheckRepoActions.IS_REPO_ROOT), false);
  check('误判时读到的分支来自外层仓库', git(nested, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'master');

  // 笔记目录本身就是仓库根的正常情形不能被误伤
  const proper = join(ROOT, 'proper-notes');
  mkdirSync(proper, { recursive: true });
  git(proper, ['init', '-b', 'main', '.']);
  check('笔记目录本身是仓库根时通过检查',
    await simpleGit({ baseDir: proper }).checkIsRepo(CheckRepoActions.IS_REPO_ROOT), true);
}

console.log('\n场景 8：首次同步自动初始化本地仓库');
{
  // 设置页不再有「初始化本地仓库」按钮，仓库改由首次同步就地建立。
  // 这条链路会真的 init / commit / push，必须端到端验证一次。
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outfile = join(repoRoot, '.dev', 'verify-git-provider.cjs');
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    stdin: {
      contents: "export { GitSyncProvider } from './src/sync/git/gitSyncProvider';",
      resolveDir: repoRoot,
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    // 产物放在仓库内，simple-git 可从 node_modules 正常解析，不必打包进来
    external: ['vscode', 'simple-git'],
    outfile,
  });

  class Uri {
    constructor(p) { this.fsPath = p; this.scheme = 'file'; }
    static file(p) { return new Uri(p); }
    static joinPath(base, ...segs) { return new Uri(join(base.fsPath, ...segs)); }
    get path() { return this.fsPath.replace(/\\/g, '/'); }
    toString() { return 'file:///' + this.fsPath.replace(/\\/g, '/'); }
  }

  const settings = new Map();
  const vscodeStub = {
    Uri,
    CancellationError: class CancellationError extends Error {},
    FileSystemError: class FileSystemError extends Error {},
    workspace: {
      textDocuments: [],
      getConfiguration: () => ({ get: (key, dflt) => (settings.has(key) ? settings.get(key) : dflt) }),
      fs: {
        async readFile(uri) { return new Uint8Array(readFileSync(uri.fsPath)); },
        async writeFile(uri, content) { writeFileSync(uri.fsPath, Buffer.from(content)); },
        async stat(uri) { if (!existsSync(uri.fsPath)) throw new Error('不存在'); return { type: 1 }; },
        async createDirectory(uri) { mkdirSync(uri.fsPath, { recursive: true }); },
      },
    },
    window: { createOutputChannel: () => ({ info() {}, warn() {}, error() {}, trace() {}, show() {} }) },
  };

  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.call(this, request, ...rest);
  };
  const { GitSyncProvider } = Module.createRequire(import.meta.url)(outfile);

  const context = { secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } };
  const makeCtx = (root) => ({
    root: Uri.file(root),
    deviceName: '测试设备',
    stateUri: Uri.file(join(ROOT, 'state')),
    legacyStateUri: Uri.file(join(ROOT, 'legacy')),
    token: { isCancellationRequested: false },
    report() {},
  });

  const autoRemote = join(ROOT, 'auto-remote.git');
  git(ROOT, ['init', '--bare', '-b', 'main', autoRemote]);
  settings.set('sync.provider', 'git');
  settings.set('sync.git.remoteUrl', autoRemote);
  settings.set('sync.git.branch', 'main');
  settings.set('sync.git.userName', 't');
  settings.set('sync.git.userEmail', 't@t');
  settings.set('sync.deviceName', '测试设备');

  // 全新的笔记目录：还不是仓库，也不在任何仓库内
  const autoNotes = join(ROOT, 'auto-init-notes');
  mkdirSync(autoNotes, { recursive: true });
  writeFileSync(join(autoNotes, '第一条笔记.md'), '内容\n');

  await new GitSyncProvider(context).sync(makeCtx(autoNotes));

  check('笔记目录已成为仓库根', existsSync(join(autoNotes, '.git')), true);
  check('分支为配置的 main', git(autoNotes, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main');
  check('已补上 .gitignore', existsSync(join(autoNotes, '.gitignore')), true);
  check('origin 指向配置的远端', git(autoNotes, ['remote', 'get-url', 'origin']).trim(), autoRemote);
  check('笔记已推送到远端', git(ROOT, ['--git-dir', autoRemote, 'ls-tree', '--name-only', 'main']).includes('第一条笔记.md'), true);

  // 笔记目录在别的仓库里时绝不能自动 init，更不能碰那个仓库
  const guarded = join(ROOT, 'guarded-project');
  mkdirSync(guarded, { recursive: true });
  git(guarded, ['init', '-b', 'master', '.']);
  writeFileSync(join(guarded, 'source.ts'), 'export const x = 1;\n');
  git(guarded, ['add', '-A']);
  git(guarded, ['commit', '-m', 'project']);
  const headBefore = git(guarded, ['rev-parse', 'HEAD']).trim();

  const guardedNotes = join(guarded, 'notes');
  mkdirSync(guardedNotes, { recursive: true });
  writeFileSync(join(guardedNotes, '笔记.md'), '内容\n');

  let blocked = '';
  try {
    await new GitSyncProvider(context).sync(makeCtx(guardedNotes));
  } catch (err) {
    blocked = err instanceof Error ? err.message : String(err);
  }

  check('位于其他仓库内部时中止同步', blocked.includes('内部'), true);
  check('没有在笔记目录建出嵌套仓库', existsSync(join(guardedNotes, '.git')), false);
  check('外层仓库没有被提交', git(guarded, ['rev-parse', 'HEAD']).trim(), headBefore);
  check('外层仓库没有被加上 origin', tryGit(guarded, ['remote', 'get-url', 'origin']).ok, false);
  check('外层仓库仍在原来的分支上', git(guarded, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'master');

  Module._load = originalLoad;
  rmSync(outfile, { force: true });
}

console.log(`\n${failures === 0 ? '全部场景通过' : `${failures} 项断言失败`}`);
rmSync(ROOT, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
