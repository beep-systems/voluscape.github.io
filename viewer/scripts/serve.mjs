import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

export const publicFiles = new Set([
  'index.html', 'app.js', 'app.css', 'controller.js', 'orientation.js', 'level.js', 'markers.js', 'marker-labels.js', 'measurements.js', 'distance-labels.js', 'camera-drag-cursor.js', 'top-controls.js',
  'i18n.js', 'locales/en.js',
  'vendor/index.js', 'vendor/index.css', 'vendor/settings.json', 'vendor/framing.js',
  'vendor/LICENSE', 'vendor/PLAYCANVAS-LICENSE', 'vendor/THIRD-PARTY.md'
]);
const rootPath = fileURLToPath(new URL('../', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/plain; charset=utf-8' };
const inside = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(rel); };

export async function createServer(rootDirectory = rootPath) {
  const root = await realpath(rootDirectory);
  return http.createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const name = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!publicFiles.has(name)) { res.writeHead(404); res.end(); return; }
      const path = await realpath(resolve(root, name));
      if (!inside(root, path) || !publicFiles.has(relative(root, path).replaceAll('\\', '/'))) {
        res.writeHead(403); res.end(); return;
      }
      const info = await stat(path);
      if (!info.isFile()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'text/plain; charset=utf-8',
        'Content-Length': info.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
        // The imported engine needs inline CSS and blob workers. Scene textures and
        // local file URLs need blob/data images; no remote scene requests are allowed.
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'" });
      if (req.method === 'HEAD') res.end();
      else await pipeline(createReadStream(path), res);
    } catch (error) {
      if (!res.headersSent) { res.writeHead(error.code === 'ENOENT' ? 404 : 400); res.end(); }
      else res.destroy();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let port = 4173, open = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--port') port = Number(args[++index]);
    else if (args[index] === '--open') open = true;
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  const server = await createServer();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Choose another with --port or -Port.` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`VoluScape Viewer: ${url}\nPress Ctrl+C to stop.`);
    if (open) {
      const options = { stdio: 'ignore', windowsHide: true };
      const child = process.platform === 'win32'
        ? spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath '${url}'`], options)
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], options);
      child.on('error', () => console.error(`Open ${url} in your browser.`));
    }
  });
  const stop = () => { server.closeAllConnections(); server.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
