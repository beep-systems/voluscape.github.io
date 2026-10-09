import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { textHash, forkUrl, upstreamUrl } from '../scripts/update-vendor.mjs';
test('vendor distribution matches pinned source manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../vendor/vendor.json', import.meta.url)));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.fork.url, forkUrl);
  assert.equal(manifest.upstream.url, upstreamUrl);
  assert.equal(manifest.upstream.tag, `v${manifest.version}`);
  for (const commit of [manifest.fork.commit, manifest.upstream.commit]) assert.match(commit, /^[a-f0-9]{40}$/);
  assert.match(manifest.build.lockfileSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.build.textNormalization, 'LF');
  assert.deepEqual(Object.keys(manifest.files).sort(), ['index.js', 'index.css', 'settings.json', 'LICENSE', 'PLAYCANVAS-LICENSE', 'THIRD-PARTY.md', 'framing.js'].sort());
  for (const [name, expected] of Object.entries(manifest.files)) assert.equal(textHash(await readFile(new URL(`../vendor/${name}`, import.meta.url))), expected, name);
  const js = await readFile(new URL('../vendor/index.js', import.meta.url), 'utf8');
  assert.ok(!js.includes('//# sourceMappingURL='));
});
