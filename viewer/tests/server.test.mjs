import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, publicFiles } from '../scripts/serve.mjs';

async function start(context, root) {
  const server = await createServer(root);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
test('allowlisted files, GET/HEAD, MIME and private paths', async context => {
  const base = await start(context);
  for (const file of publicFiles) assert.equal((await fetch(`${base}/${file}`, { method: 'HEAD' })).status, 200, file);
  const response = await fetch(base);
  assert.match(await response.text(), /data-i18n-aria-label="scene.open"/);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self' blob:/);
  assert.match((await fetch(`${base}/controller.js`)).headers.get('content-type'), /javascript/);
  for (const path of ['/README.md', '/package.json', '/scripts/serve.mjs', '/tests/server.test.mjs', '/vendor/vendor.json', '/.git/config', '/../AGENTS.md', '/%2e%2e%2fAGENTS.md', '/..%5cAGENTS.md', '/missing.sog']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/%ZZ')).status, 400);
});
test('symlink outside the public root is refused', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'voluscape-viewer-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const external = join(directory, 'private');
  const root = join(directory, 'root');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(external); await mkdir(root);
  await writeFile(join(external, 'index.js'), 'private');
  await symlink(external, join(root, 'vendor'), process.platform === 'win32' ? 'junction' : 'dir');
  const base = await start(context, root);
  assert.equal((await fetch(base + '/vendor/index.js')).status, 403);
});
test('symlink to a private file inside the root is also refused', async context => {
  const root = await mkdtemp(join(tmpdir(), 'voluscape-viewer-internal-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { mkdir } = await import('node:fs/promises');
  const scripts = join(root, 'scripts');
  await mkdir(scripts); await writeFile(join(scripts, 'index.js'), 'private');
  await symlink(scripts, join(root, 'vendor'), process.platform === 'win32' ? 'junction' : 'dir');
  const base = await start(context, root);
  assert.equal((await fetch(base + '/vendor/index.js')).status, 403);
});
