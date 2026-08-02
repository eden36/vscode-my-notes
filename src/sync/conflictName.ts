import * as path from 'path';

/** 文件名中不允许出现的字符，设备名可能含有这些字符 */
function sanitizeDeviceName(deviceName: string): string {
  const cleaned = deviceName.replace(/[\\/:*?"<>|.\s]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'unknown';
}

export function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * 生成冲突副本的文件名：`原名.conflict-设备名-时间.原扩展名`。
 * 保留原扩展名，副本才能照常在笔记列表中显示并被编辑器识别。
 */
export function conflictFileName(originalName: string, deviceName: string, date: Date): string {
  const ext = path.extname(originalName);
  const base = ext ? originalName.slice(0, -ext.length) : originalName;
  return `${base}.conflict-${sanitizeDeviceName(deviceName)}-${formatTimestamp(date)}${ext}`;
}

/** 判断文件名是否为本插件生成的冲突副本 */
export function isConflictFileName(name: string): boolean {
  return /\.conflict-[^.]+-\d{8}-\d{6}(-\d+)?(\.[^.]+)?$/.test(name);
}
