import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from '../scripts/serve.mjs';

for (const prefix of ['', '/preview']) {
  test(`loopback static hosting, nested assets and MP4 seeking: ${prefix || '/'}`, async (context) => {
    const server = await createServer(fileURLToPath(new URL('../', import.meta.url)), { prefix });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}${prefix}`;
    for (const path of ['/', '/assets/gallery.js', '/viewer/index.html', '/viewer/embed.html', '/viewer/embed.js', '/viewer/index.js', '/viewer/settings.json']) {
      assert.equal((await fetch(base + path, { method: 'HEAD' })).status, 200, path);
    }
    for (const id of ['ch', 'hs', 'qt', 'rd', 'sl', 'tw', 'wh']) {
      const response = await fetch(`${base}/web-video/${id}-720p.mp4`, { headers: { Range: 'bytes=0-31' } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-type'), 'video/mp4');
      assert.equal((await response.arrayBuffer()).byteLength, 32);
    }
    assert.equal((await fetch(base + '/scenes/missing.sog', { method: 'HEAD' })).status, 404);
    assert.equal((await fetch(base + '/web-video/ch-720p.mp4', { headers: { Range: 'bytes=999999999-' } })).status, 416);
  });
}
