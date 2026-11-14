import type { WebDAVClient } from 'webdav' with { 'resolution-mode': 'import' };
import type { SyncContext } from '../syncProvider';
import { assertSyncActive } from '../syncProvider';
import type { RemoteFile } from './diff';
import { hashContent } from './scanner';
import { randomUUID } from 'crypto';
export class RemoteChangedError extends Error {
}
export class UncertainWriteError extends Error {
}
export interface RemoteContent {
  content: Uint8Array;
  file: RemoteFile;
}
export function isStrongEtag(value: string | undefined): value is string {
  return Boolean(value && /^"[^"\r\n]*"$/.test(value));
}
function statusCode(error: unknown): number | undefined {
  return (error as {
    status?: number;
  })?.status;
}
export function requestSignal(context: Pick<SyncContext, 'signal'>, timeout = 60_000): AbortSignal {
  const deadline = AbortSignal.timeout(timeout);
  return context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
}
/** 版本信息始终与同次响应内容关联，条件冲突交回执行器重新规划。 */
export class WebdavTransport {
  compatibility = false;
  private conditions: boolean | undefined;
  constructor(private readonly client: WebDAVClient, private readonly context: SyncContext) {
  }
  async read(remotePath: string, expected?: RemoteFile): Promise<RemoteContent> {
    for (let attempt = 0;;attempt++) {
      assertSyncActive(this.context);
      try {
        const data = await this.client.getFileContents(remotePath, {
          format: 'binary', details: true, signal: requestSignal(this.context),
          headers: this.conditions !== false && isStrongEtag(expected?.etag) ? {
            'If-Match': expected.etag
          } : {},
        });
        const detailed = data && typeof data === 'object' && 'data' in data ? data : undefined;
        const bytes = detailed ? detailed.data : data;
        const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as ArrayBuffer);
        const headers = detailed?.headers ?? {};
        const etag = headers['etag'] ?? headers['ETag'];
        if (!isStrongEtag(typeof etag === 'string' ? etag : undefined)) {
          this.compatibility = true;
        }
        return {
          content, file: {
            size: content.byteLength, hash: hashContent(content),
            etag: typeof etag === 'string' ? etag : undefined,
            lastmod: headers['last-modified']
          }
        };
      }
      catch (error) {
        if (statusCode(error) === 412 || statusCode(error) === 404) {
          throw new RemoteChangedError('远端文件版本发生变化。');
        }
        if (attempt || this.context.signal?.aborted || (statusCode(error) ?? 500) < 500) {
          throw error;
        }
      }
    }
  }
  async write(remotePath: string, content: Uint8Array, expected?: RemoteFile): Promise<RemoteFile> {
    await this.preflight(remotePath, expected);
    assertSyncActive(this.context);
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream'
    };
    if (!expected) {
      headers['If-None-Match'] = '*';
    }
    else if (this.conditions !== false && isStrongEtag(expected.etag)) {
      headers['If-Match'] = expected.etag;
    }
    try {
      if (typeof this.client.customRequest === 'function') {
        const response = await this.client.customRequest(remotePath, {
          method: 'PUT', headers, data: Buffer.from(content), signal: requestSignal(this.context),
        });
        const etag = response.headers.get('etag');
        if (etag) {
          return {
            size: content.byteLength, hash: hashContent(content), etag, lastmod: response.headers.get('last-modified') ?? undefined
          };
        }
      }
      else {
        const written = await this.client.putFileContents(remotePath, Buffer.from(content), {
          overwrite: Boolean(expected), headers, signal: requestSignal(this.context),
        });
        if (!written) {
          throw new RemoteChangedError('远端已有同名文件。');
        }
      }
      const verified = await this.read(remotePath);
      if (verified.file.hash !== hashContent(content)) {
        throw new RemoteChangedError('上传后远端已被修改，已保留旧基线等待重新比较。');
      }
      return verified.file;
    }
    catch (error) {
      if (error instanceof RemoteChangedError || statusCode(error) === 412) {
        throw new RemoteChangedError('远端版本冲突，需重新比较。');
      }
      if (statusCode(error) && statusCode(error)! < 500) {
        throw error;
      }
      throw new UncertainWriteError(`上传结果待核实：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async delete(remotePath: string, expected: RemoteFile | undefined): Promise<void> {
    await this.preflight(remotePath, expected);
    assertSyncActive(this.context);
    try {
      await this.client.deleteFile(remotePath, {
        headers: this.conditions !== false && isStrongEtag(expected?.etag) ? {
          'If-Match': expected.etag
        } : {},
        signal: requestSignal(this.context),
      });
    }
    catch (error) {
      if (statusCode(error) === 404) {
        return;
      }
      if (statusCode(error) === 412) {
        throw new RemoteChangedError('远端删除前文件已被修改。');
      }
      if (statusCode(error) && statusCode(error)! < 500) {
        throw error;
      }
      throw new UncertainWriteError(`删除结果待核实：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private async preflight(remotePath: string, expected?: RemoteFile): Promise<void> {
    if (!expected) {
      return;
    }
    if (isStrongEtag(expected.etag) && this.conditions === undefined && typeof this.client.getFileContents === 'function') {
      try {
        // 不匹配的读取条件用于无副作用探测，忽略条件的服务转入兼容模式。
        await this.client.getFileContents(remotePath, { format: 'binary', details: true,
          headers: { 'If-Match': `"syncnotes-probe-${randomUUID()}"` }, signal: requestSignal(this.context) });
        this.conditions = false;
      } catch (error) {
        if (statusCode(error) === 412) { this.conditions = true; }
        else if (statusCode(error) === 400 || statusCode(error) === 501) { this.conditions = false; }
        else { throw error; }
      }
    }
    if (isStrongEtag(expected.etag) && this.conditions !== false) { return; }
    this.compatibility = true;
    const current = await this.read(remotePath);
    if (!expected.hash || current.file.hash !== expected.hash) {
      throw new RemoteChangedError('远端内容已变化。');
    }
  }
}
