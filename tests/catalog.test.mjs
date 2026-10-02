import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { validateCatalog, mediaURL, selectionHash, selectionFromHash } from '../assets/catalog.js';

const base = 'https://example.github.io/preview/';
const fixture = () => [{ id: 'ch', title: 'ch', video: 'web-video/ch-720p.mp4', results: [{ id: 'balanced', label: 'Balanced', scene: 'scenes/ch/balanced.sog' }, { id: 'raw', label: 'Raw', scene: 'scenes/ch/raw.ply', settings: 'scenes/ch/settings.json' }] }];

test('catalog paths remain under a GitHub Pages repository prefix', () => {
  const catalog = validateCatalog(fixture(), base);
  assert.equal(mediaURL(catalog[0].video, base).href, 'https://example.github.io/preview/web-video/ch-720p.mp4');
  assert.equal(mediaURL(catalog[0].results[0].scene, base).pathname, '/preview/scenes/ch/balanced.sog');
});
test('share links restore arbitrary variants and recover from stale selections', () => {
  const catalog = fixture();
  const hash = selectionHash(catalog[0], catalog[0].results[1]);
  assert.equal(selectionFromHash(catalog, hash).result.id, 'raw');
  assert.equal(selectionFromHash(catalog, '#test=unknown&variant=unknown').result.id, 'balanced');
  catalog[0].results = [];
  assert.equal(selectionFromHash(catalog, hash).result, null);
});
test('invalid catalogs, duplicate identifiers and unsafe URLs are rejected', () => {
  for (const input of [null, [], {}, [{}]]) assert.throws(() => validateCatalog(input, base));
  const duplicate = fixture(); duplicate.push(duplicate[0]);
  assert.throws(() => validateCatalog(duplicate, base), /Duplicate/);
  for (const path of ['https://elsewhere/scene.sog', '//elsewhere/a.sog', '/scene.sog', 'javascript:alert(1)', 'C:\\scene.sog']) {
    assert.throws(() => mediaURL(path, base));
  }
  const bad = fixture(); bad[0].results[0].scene = 'mesh.glb';
  assert.throws(() => validateCatalog(bad, base), /SOG/);
  bad[0].results[0].scene = 'scene.sog'; bad[0].results[0].sizeBytes = '100';
  assert.throws(() => validateCatalog(bad, base), /sizeBytes/);
});
test('catalog references all seven existing videos and available scene files', async () => {
  const catalog = validateCatalog(JSON.parse(await readFile(new URL('../catalog.json', import.meta.url))), base);
  assert.deepEqual(catalog.map((item) => item.id), ['ch', 'hs', 'qt', 'rd', 'sl', 'tw', 'wh']);
  for (const item of catalog) {
    const info = await stat(new URL(item.video, new URL('../', import.meta.url)));
    assert.equal(info.size, item.sizeBytes);
    for (const result of item.results) {
      const sceneInfo = await stat(new URL(result.scene, new URL('../', import.meta.url)));
      if (result.sizeBytes !== undefined) assert.equal(sceneInfo.size, result.sizeBytes);
    }
  }
});
