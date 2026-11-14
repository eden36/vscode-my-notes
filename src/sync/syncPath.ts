import * as path from 'path';
const SKIPPED = new Set(['.git', '.svn', '.hg', 'node_modules', '$RECYCLE.BIN', '.DS_Store', 'Thumbs.db', 'desktop.ini']);
/** 外部相对路径必须留在笔记根目录内，统一过滤系统元数据。 */
export function isSafeRelativePath(relative: string): boolean {
  const segments = relative.split('/');
  // eslint-disable-next-line no-control-regex
  const invalid = /[\x00-\x1f:]/;
  return relative.length > 0 && !path.isAbsolute(relative) && !relative.includes('\\') &&
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..' &&
      !invalid.test(segment));
}
export function isSyncPath(relative: string): boolean {
  return isSafeRelativePath(relative) && relative.split('/').every(segment => !SKIPPED.has(segment) && !segment.startsWith('.syncnotes-tmp-'));
}
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
