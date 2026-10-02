import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build, withDirectory, escapeHTML } from '../scripts/build.mjs';
import { createServer } from '../scripts/serve.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const catalog = JSON.parse(await readFile(new URL('../catalog.json', import.meta.url)));
test('static scene directory stays synchronized, escaped, and indexable', async () => {
  const html = await readFile(resolve(root, 'index.html'), 'utf8');
  assert.equal(html, withDirectory(html, catalog), 'run npm run content after editing catalog');
  assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1);
  for (const scene of catalog) { assert.ok(html.includes(escapeHTML(scene.title))); assert.ok(html.includes(escapeHTML(scene.description))); }
  assert.match(withDirectory('<!-- catalog:start --><!-- catalog:end -->', [{ id: 'safe', title: '<script>', description: '&"' }]), /&lt;script&gt;/);
  assert.match(html, /rel="canonical" href="https:\/\/voluscape.beep.systems\/"/);
  assert.match(html, /property="og:image"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  for (const file of ['viewer/index.html', 'viewer/embed.html']) assert.match(await readFile(resolve(root, file), 'utf8'), /name="robots" content="noindex"/);
});
test('publication artifact excludes private/development files and preserves media bytes', async context => {
  await mkdir(resolve(root, 'build'), { recursive: true });
  const destination = await mkdtemp(resolve(root, 'build/publication-test-'));
  context.after(() => rm(destination, { recursive: true, force: true }));
  const files = await build(destination);
  // A rebuild removes stale files and produces the same bytes.
  const indexBefore = await readFile(resolve(destination, 'index.html'));
  await build(destination);
  assert.deepEqual(await readFile(resolve(destination, 'index.html')), indexBefore);
  const top = await readdir(destination);
  assert.deepEqual(top.sort(), ['.nojekyll', 'assets', 'catalog.json', 'index.html', 'robots.txt', 'scenes', 'sitemap.xml', 'viewer', 'web-video'].sort());
  const fingerprint = buffer => createHash('sha256').update(buffer).digest('hex');
  for (const file of files) {
    assert.ok(!/README|THIRD-PARTY|vendor\.json|\.patch$|PLAN|VERIFICATION|tests\/|scripts\//.test(file), file);
    const bytes = await readFile(resolve(destination, file));
    if (/\.(mp4|sog|ply)$/.test(file)) assert.equal(fingerprint(bytes), fingerprint(await readFile(resolve(root, file))), file);
    else if (/\.(html|css|js|json|xml|txt|svg)$/.test(file)) {
      assert.doesNotMatch(bytes.toString(), /samlu|BeepSystems|\b[A-Z]:[\\/]|C:\\Users|mailto:|sourceMappingURL/i, file);
    }
  }
  const server = await createServer(destination, { prefix: '/preview' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/preview/`;
  for (const file of files) assert.equal((await fetch(base + file, { method: 'HEAD' })).status, 200, file);
  for (const file of ['README.md', 'tests/browser.mjs', 'viewer/THIRD-PARTY.md', '.idea/workspace.xml']) assert.equal((await fetch(base + file)).status, 404);
});
