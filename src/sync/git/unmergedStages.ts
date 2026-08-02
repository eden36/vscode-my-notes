/** 合并冲突时某个文件在暂存区留下的三个阶段 */
export const STAGE_BASE = 1;
export const STAGE_LOCAL = 2;
export const STAGE_REMOTE = 3;

/**
 * 解析 `git ls-files -u -z` 的输出。
 *
 * 每条记录形如 `100644 <sha> 2\t<path>`，记录之间以 NUL 分隔。
 * 用 -z 而非 --diff-filter=U，一来路径不会被转义或加引号，
 * 二来能看到每个文件保留了哪些阶段：缺少阶段 2 说明本地删除了该文件，
 * 缺少阶段 3 说明远端删除了该文件——两种情况的处理方式完全不同。
 */
export function parseUnmergedStages(raw: string): Map<string, Set<number>> {
  const stages = new Map<string, Set<number>>();

  for (const entry of raw.split('\0')) {
    if (!entry) {
      continue;
    }
    const tab = entry.indexOf('\t');
    if (tab < 0) {
      continue;
    }
    const fields = entry.slice(0, tab).trim().split(/\s+/);
    const stage = Number(fields[2]);
    const filePath = entry.slice(tab + 1);
    if (!filePath || !Number.isInteger(stage) || stage < STAGE_BASE || stage > STAGE_REMOTE) {
      continue;
    }
    const set = stages.get(filePath) ?? new Set<number>();
    set.add(stage);
    stages.set(filePath, set);
  }

  return stages;
}
