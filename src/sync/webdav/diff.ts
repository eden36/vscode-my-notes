import type { ManifestEntry } from './manifest';
import type { LocalFile } from './scanner';

export interface RemoteFile {
  size: number;
  hash?: string;
  etag?: string;
  lastmod?: string;
}

export type SyncAction =
  /** 本地内容较新，推送到远端 */
  | { type: 'upload'; path: string }
  /** 远端内容较新，拉取到本地 */
  | { type: 'download'; path: string }
  /** 远端删除且本地未改动，同步删除本地文件 */
  | { type: 'deleteLocal'; path: string }
  /** 本地删除且远端未改动，同步删除远端文件 */
  | { type: 'deleteRemote'; path: string }
  /** 双方都有该文件且都可能变化，需取回远端内容比对后再判定 */
  | { type: 'compare'; path: string }
  /** 远端已删除但本地有修改：保留并上传本地，作为冲突提示 */
  | { type: 'resurrectLocal'; path: string }
  /** 本地已删除但远端有修改：恢复远端内容，作为冲突提示 */
  | { type: 'resurrectRemote'; path: string }
  /** 双方一致，无需传输，仅刷新清单指纹 */
  | { type: 'record'; path: string }
  /** 双方均已删除，从清单中移除 */
  | { type: 'forget'; path: string };

/** ETag 可能带引号或弱校验前缀，比较前统一去掉 */
function normalizeEtag(etag: string): string {
  return etag.replace(/^W\//, '').replace(/^"|"$/g, '');
}

export function localChanged(base: ManifestEntry, local: LocalFile): boolean {
  return base.hash !== local.hash;
}

export function remoteChanged(base: ManifestEntry, remote: RemoteFile): boolean {
  if (remote.hash) {
    return base.hash !== remote.hash;
  }
  // ETag 是服务端给出的内容标识，优先采用；缺失时退化为大小与修改时间
  if (base.remoteEtag && remote.etag) {
    return normalizeEtag(base.remoteEtag) !== normalizeEtag(remote.etag);
  }
  return base.size !== remote.size || base.remoteLastmod !== remote.lastmod;
}

/**
 * 三方对比：以上次同步留下的清单为基线，判定本地与远端各自发生了什么，
 * 从而区分「新增」「修改」「删除」——只比修改时间是做不到这一点的，
 * 会把远端尚未拥有的新文件和本地已删除的文件混为一谈。
 */
export function planSync(
  base: Record<string, ManifestEntry>,
  local: Map<string, LocalFile>,
  remote: Map<string, RemoteFile>,
): SyncAction[] {
  const paths = new Set<string>([...Object.keys(base), ...local.keys(), ...remote.keys()]);
  const actions: SyncAction[] = [];

  for (const path of [...paths].sort()) {
    const b = Object.hasOwn(base, path) ? base[path] : undefined;
    const l = local.get(path);
    const r = remote.get(path);

    if (!b) {
      if (l && r) {
        actions.push({ type: 'compare', path });
      } else if (l) {
        actions.push({ type: 'upload', path });
      } else if (r) {
        actions.push({ type: 'download', path });
      }
      continue;
    }

    if (l && r) {
      const lc = localChanged(b, l);
      const rc = remoteChanged(b, r);
      if (lc && rc) {
        actions.push({ type: 'compare', path });
      } else if (lc) {
        actions.push({ type: 'upload', path });
      } else if (rc) {
        actions.push({ type: 'download', path });
      } else {
        actions.push({ type: 'record', path });
      }
      continue;
    }

    if (l && !r) {
      actions.push(localChanged(b, l) ? { type: 'resurrectLocal', path } : { type: 'deleteLocal', path });
      continue;
    }

    if (!l && r) {
      actions.push(remoteChanged(b, r) ? { type: 'resurrectRemote', path } : { type: 'deleteRemote', path });
      continue;
    }

    actions.push({ type: 'forget', path });
  }

  return actions;
}
