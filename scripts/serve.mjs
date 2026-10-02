import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, relative, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.sog': 'application/octet-stream', '.ply': 'application/octet-stream' };
const inside = (root, path) => { const rel = relative(root, path); return !rel.startsWith('..') && !isAbsolute(rel); };

export async function createServer(rootPath, { prefix = '' } = {}) {
  const root = await realpath(rootPath);
  return http.createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
      let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (prefix) {
        if (pathname === prefix) { res.writeHead(301, { Location: prefix + '/' }); res.end(); return; }
        if (!pathname.startsWith(prefix + '/')) { res.writeHead(404); res.end(); return; }
        pathname = pathname.slice(prefix.length);
      }
      let path = resolve(root, '.' + pathname);
      if (!inside(root, path)) { res.writeHead(403); res.end(); return; }
      let info = await stat(path);
      if (info.isDirectory()) {
        if (!pathname.endsWith('/')) { res.writeHead(301, { Location: prefix + pathname + '/' }); res.end(); return; }
        path = resolve(path, 'index.html');
        info = await stat(path);
      }
      path = await realpath(path);
      if (!inside(root, path) || !info.isFile()) { res.writeHead(403); res.end(); return; }
      let start = 0;
      let end = info.size - 1;
      let status = 200;
      const headers = { 'Content-Type': mime[extname(path).toLowerCase()] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
      if (req.headers.range && req.method === 'GET') {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
        start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
        if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      }
      headers['Content-Length'] = Math.max(0, end - start + 1);
      res.writeHead(status, headers);
      if (req.method === 'HEAD' || info.size === 0) { res.end(); return; }
      await pipeline(createReadStream(path, { start, end }), res);
    } catch (error) {
      if (!res.headersSent) { res.writeHead(error.code === 'ENOENT' ? 404 : 400); res.end(); }
      else res.destroy();
    }
  });
}

const entryPath = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => '') : '';
if (entryPath && entryPath === await realpath(fileURLToPath(import.meta.url))) {
  const prefixIndex = process.argv.indexOf('--prefix');
  const prefix = prefixIndex === -1 ? '' : process.argv[prefixIndex + 1];
  if (typeof prefix !== 'string' || (prefix && !/^\/[a-zA-Z0-9_-]+$/.test(prefix))) throw new Error('Use --prefix /repository-name');
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex === -1 ? fileURLToPath(new URL('../', import.meta.url)) : resolve(process.argv[rootIndex + 1]);
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex === -1 ? 4173 : Number(process.argv[portIndex + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use --port with a number from 1 to 65535');
  const server = await createServer(root, { prefix });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`Preview: http://127.0.0.1:${port}${prefix}/`);
}
