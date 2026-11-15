import * as path from 'path';
import { isInside } from '../sync/syncPath';

export type DropTargetKind = 'folder' | 'note' | undefined;

/** 去掉已被选中祖先覆盖的子孙路径，只保留顶层项。 */
export function dedupeSelection(paths: string[]): string[] {
  const normalized = paths.map((p) => path.normalize(p));
  const unique = [...new Set(normalized)];
  return unique.filter((candidate) => !unique.some((other) => other !== candidate && isStrictDescendant(other, candidate)));
}

/** child 是否为 parent 自身或其严格子孙。 */
export function isSelfOrDescendant(parent: string, child: string): boolean {
  const a = path.normalize(parent);
  const b = path.normalize(child);
  return a === b || isStrictDescendant(a, b);
}

/**
 * 若把 source 复制到 destDir 下，目标是否会落在 source 自身或其子路径内
 * （会导致递归复制时再次扫到新建目标）。
 */
export function isNestedCopyDestination(sourcePath: string, destDirPath: string): boolean {
  return isSelfOrDescendant(sourcePath, destDirPath);
}

function isStrictDescendant(parent: string, child: string): boolean {
  const relative = path.relative(path.normalize(parent), path.normalize(child));
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/**
 * 解析落点目录：无目标 → 根；文件夹 → 自身；笔记 → 父目录。
 * 结果必须在笔记根内，否则返回 undefined。
 */
export function resolveDropDirectory(
  rootPath: string,
  targetPath: string | undefined,
  targetKind: DropTargetKind,
): string | undefined {
  const root = path.normalize(rootPath);
  let dest: string;
  if (!targetPath) {
    dest = root;
  } else if (targetKind === 'folder') {
    dest = path.normalize(targetPath);
  } else if (targetKind === 'note') {
    dest = path.normalize(path.dirname(targetPath));
  } else {
    return undefined;
  }
  if (!isInside(root, dest)) {
    return undefined;
  }
  return dest;
}

/** 在已占用名称集合上分配 `name (2).ext` / `name (2)` 形式的唯一名。 */
export function allocateUniqueName(
  baseName: string,
  taken: ReadonlySet<string>,
  caseInsensitive = false,
): string {
  const isTaken = (name: string) => {
    if (taken.has(name)) {
      return true;
    }
    if (!caseInsensitive) {
      return false;
    }
    const key = name.toLowerCase();
    for (const existing of taken) {
      if (existing.toLowerCase() === key) {
        return true;
      }
    }
    return false;
  };
  if (!isTaken(baseName)) {
    return baseName;
  }
  const parsed = path.parse(baseName);
  const stem = parsed.name;
  const ext = parsed.ext;
  let index = 2;
  while (true) {
    const candidate = `${stem} (${index})${ext}`;
    if (!isTaken(candidate)) {
      return candidate;
    }
    index += 1;
  }
}
