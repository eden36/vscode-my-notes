// 本地可控服务支持版本条件、并发改动与故障注入。
import http from 'node:http';
import { once } from 'node:events';
const escapeXml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
export async function webdavFixture({ etags = 'strong', conditions = true } = {}) {
  const files = new Map();
  const directories = new Set(['/']);
  const beforeList = new Map();
  const beforeRequest = new Map();
  const afterPut = new Map();
  const failures = new Map();
  const requests = [];
  let version = 0;
  const set = (file, content) => {
    const etag = `"${++version}"`;
    files.set(file, {
      content: Buffer.from(content), etag: etags === 'weak' ? `W/${etag}` : etags === 'none' ? undefined : etag,
      lastmod: new Date(1700000000000 + version * 1000).toUTCString()
    });
    directories.add(file.slice(0, file.lastIndexOf('/')) || '/');
  };
  const responseXml = (file, entry) => {
    const directory = !entry;
    const href = `/dav${file}${directory && !file.endsWith('/') ? '/' : ''}`;
    return `<d:response><d:href>${escapeXml(encodeURI(href))}</d:href><d:propstat><d:prop>` +
      `<d:resourcetype>${directory ? '<d:collection/>' : ''}</d:resourcetype>` +
      `<d:getcontentlength>${entry?.content.length ?? 0}</d:getcontentlength>` +
      `<d:getlastmodified>${entry?.lastmod ?? new Date(0).toUTCString()}</d:getlastmodified>` +
      `${entry?.etag ? `<d:getetag>${escapeXml(entry.etag)}</d:getetag>` : ''}` +
      `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  };
  const server = http.createServer(async (request, response) => {
    try {
      const relative = decodeURI(new URL(request.url, 'http://localhost').pathname).replace(/^\/dav/, '').replace(/\/$/, '') || '/';
      const method = request.method;
      const failureKey = `${method} ${relative}`;
      requests.push(failureKey);
      if (beforeRequest.has(failureKey)) {
        const hook = beforeRequest.get(failureKey);
        beforeRequest.delete(failureKey);
        await hook();
      }
      if (failures.has(failureKey)) {
        const status = failures.get(failureKey);
        failures.delete(failureKey);
        response.writeHead(status);
        response.end();
        return;
      }
      const entry = files.get(relative);
      if (conditions && request.headers['if-match'] && request.headers['if-match'] !== entry?.etag) {
        response.writeHead(412);
        response.end();
        return;
      }
      if (conditions && request.headers['if-none-match'] === '*' && entry) {
        response.writeHead(412);
        response.end();
        return;
      }
      if (method === 'PROPFIND') {
        if (!entry && !directories.has(relative)) {
          response.writeHead(404);
          response.end();
          return;
        }
        if (request.headers.depth === 'infinity' && beforeList.has(relative)) {
          const hook = beforeList.get(relative);
          beforeList.delete(relative);
          await hook();
        }
        const entries = [responseXml(relative, files.get(relative))];
        if (!entry && request.headers.depth !== '0') {
          for (const [name, value] of files) {
            if (name.startsWith(`${relative}/`)) {
              entries.push(responseXml(name, value));
            }
          }
        }
        response.writeHead(207, {
          'Content-Type': 'application/xml; charset=utf-8'
        });
        response.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entries.join('')}</d:multistatus>`);
        return;
      }
      if (method === 'MKCOL') {
        directories.add(relative);
        response.writeHead(201);
        response.end();
        return;
      }
      if (method === 'PUT') {
        const chunks = [];
        for await (const chunk of request) {
          chunks.push(chunk);
        }
        set(relative, Buffer.concat(chunks));
        const uploaded = files.get(relative);
        const headers = uploaded.etag ? {
          ETag: uploaded.etag
        } : {};
        response.writeHead(201, headers);
        response.end();
        if (afterPut.has(relative)) {
          const hook = afterPut.get(relative);
          afterPut.delete(relative);
          await hook();
        }
        return;
      }
      if (!entry) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (method === 'DELETE') {
        files.delete(relative);
        response.writeHead(204);
        response.end();
        return;
      }
      if (method === 'GET' || method === 'HEAD') {
        response.writeHead(200, {
          ...(entry.etag ? {
            ETag: entry.etag
          } : {}), 'Last-Modified': entry.lastmod, 'Content-Type': 'application/octet-stream'
        });
        response.end(method === 'GET' ? entry.content : undefined);
        return;
      }
      response.writeHead(405);
      response.end();
    }
    catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}/dav`, files, directories, beforeList, beforeRequest, afterPut, failures, requests, set,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
