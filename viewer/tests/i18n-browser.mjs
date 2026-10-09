import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from '../scripts/serve.mjs';
import { gaussianPly } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? require.resolve('playwright')));
const output = new URL('../../build/viewer-i18n-browser/', import.meta.url);
await mkdir(output, { recursive: true });
const server = await createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true, ...(process.env.PREVIEW_BROWSER ? { executablePath: process.env.PREVIEW_BROWSER } : {}) });
const report = { browser: browser.version(), checks: [], errors: [], scope: 'Synthetic localization checks with a test-only second dictionary; no shipping second locale or physical-phone evidence.' };
const fixture = {
  'scene.open': 'Test öffnen', 'scene.openHint': 'Test öffnen — {detail}',
  'scene.closeFileHint': 'Test schließen — {filename}', 'scene.empty': '<b>Literal hint</b>',
  'scene.noLevelEstimate': 'Test level', 'scene.estimatedTilt': 'Test tilt {degrees}',
  'marker.editHint': 'Test edit', 'marker.name': 'Test name', 'marker.notePlaceholder': 'Test note',
  'marker.unsaved': 'Test unsaved', 'marker.saved': 'Test saved',
  'marker.defaultReferenceName': 'Test Punkt {id}', 'color.red': 'Test red',
  'scale.notSet': 'Test scale', 'scale.routeLength': 'Test route {distance}',
  'scale.segmentLength': 'Test segment {distance}', 'scale.pickA': 'Test A', 'scale.pickB': 'Test B',
  'scale.enterDistance': 'Test distance', 'error.positiveDistance': 'Test positive',
  'error.invalidFile': 'Test file', 'route.deleteConfirm': 'Test delete {count}',
  'action.cancel': 'Test cancel'
};
const ready = page => page.waitForFunction(() => document.getElementById('scene-host').dataset.status === 'ready');
const snapshot = page => page.evaluate(async () => {
  const { controller: c, i18n } = await import('/app.js');
  return { locale: i18n.locale, controllerLocale: c.i18n.locale, upstreamLocale: c.viewer?.app ? document.querySelector('#scene-host .sse-viewer')?.lang : null,
    markers: c.markers, measurements: c.measurements, renderer: c.viewer?.app.graphicsDevice.deviceType };
});
async function project(page, position) {
  return page.evaluate(async position => {
    const { controller: c } = await import('/app.js');
    const component = c.viewer.app.root.findComponents('gsplat')[0];
    const point = component.entity.getPosition().clone().set(...position);
    component.entity.getWorldTransform().transformPoint(point, point);
    const screen = c.viewer.app.root.findComponents('camera')[0].worldToScreen(point);
    return { x: screen.x, y: screen.y };
  }, position);
}
async function clickScene(page, position) {
  const screen = await project(page, position); await page.mouse.click(screen.x, screen.y);
}
try {
  // Browser preferences never choose a custom locale implicitly.
  const context = await browser.newContext({ locale: 'de-DE' });
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  for (const query of ['', '?lang=RU', '?lang=EN-us']) {
    await page.goto(base + query);
    await page.waitForFunction(() => document.getElementById('open-scene').getAttribute('aria-label') === 'Open scene');
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  }
  report.checks.push('Default, unsupported and English regional tags resolve to English regardless of browser language');
  await page.route('**/i18n.js', async route => {
    const response = await route.fetch(), source = await response.text();
    assert.ok(source.includes('export const locales = Object.freeze({ en });'));
    await route.fulfill({ response, body: source.replace('export const locales = Object.freeze({ en });', `export const locales = Object.freeze({ en, de: ${JSON.stringify(fixture)} });`) });
  });
  await page.goto(base + '?lang=DE-de&webgl');
  await page.waitForFunction(() => document.getElementById('open-scene').getAttribute('aria-label') === 'Test öffnen');
  assert.equal(await page.locator('html').getAttribute('lang'), 'de');
  assert.equal(await page.locator('#empty-state span').textContent(), '<b>Literal hint</b>');
  assert.equal(await page.locator('#empty-state b').count(), 0);
  assert.equal(await page.locator('#open-scene svg').count(), 1);
  assert.equal(await page.locator('#open-scene').getAttribute('title'), 'Test öffnen — No scene loaded');
  assert.equal(await page.locator('#marker-name-wrap label').textContent(), 'Test name');
  assert.equal(await page.locator('#marker-note').getAttribute('placeholder'), 'Test note');
  assert.equal(await page.locator('#save-marker').textContent(), 'Save'); // per-key fallback
  await page.locator('#scene-file').setInputFiles({name:'<b>ground</b>.ply',mimeType:'application/octet-stream',buffer:gaussianPly()});
  await ready(page);
  const initial = await snapshot(page);
  assert.equal(initial.upstreamLocale, 'de'); assert.equal(initial.controllerLocale, 'de');
  assert.equal(await page.locator('#close-scene').getAttribute('title'), 'Test schließen — <b>ground</b>.ply');
  assert.equal(await page.locator('#scene-tools b').count(), 0);
  assert.equal(await page.locator('#route-length').textContent(), 'Test scale');
  assert.equal(await page.locator('#edit-mode').getAttribute('title'), 'Test edit');
  report.checks.push('Test dictionary translates text/aria/hints/placeholders, preserves SVG and HTML-like filenames, and agrees with upstream language');

  await page.locator('#set-scale').click(); assert.equal(await page.locator('#scale-hint').textContent(), 'Test A');
  await clickScene(page, [0,0,0]);
  await page.waitForFunction(() => document.getElementById('scale-hint').textContent === 'Test B');
  await clickScene(page, [1,0,-.2]); await page.locator('#scale-distance').waitFor({state:'visible'});
  assert.equal(await page.locator('#scale-hint').textContent(), 'Test distance');
  await page.locator('#scale-distance').fill('0'); await page.locator('#apply-scale').click();
  assert.equal(await page.locator('#scale-error').textContent(), 'Test positive');
  await page.locator('#scale-distance').fill('4,0'); await page.locator('#apply-scale').click();
  assert.equal(await page.locator('#route-length').textContent(), 'Test route 0,00');
  await page.locator('#reference-mode').click(); await clickScene(page, [0,0,0]);
  await page.waitForFunction(() => document.getElementById('marker-name').value === 'Test Punkt 1');
  assert.equal(await page.locator('#marker-palette button').first().getAttribute('title'), 'Test red');
  await page.locator('#marker-name').fill('<b>User name</b>'); await page.locator('#marker-note').fill('User comment');
  assert.equal(await page.locator('#marker-save-status').textContent(), 'Test unsaved');
  await page.locator('#save-marker').click(); assert.equal(await page.locator('#marker-save-status').textContent(), 'Test saved');
  assert.equal((await snapshot(page)).markers[0].name, '<b>User name</b>');
  assert.equal((await snapshot(page)).markers[0].note, 'User comment');
  for (const [index, point] of [[-1,0,.2], [1,0,-.2]].entries()) {
    await page.locator('#route-mode').click(); await clickScene(page, point);
    await page.waitForFunction(count => document.getElementById('marker-count').textContent === `Markers: ${count}`, index + 2);
  }
  const beforeDelete = await snapshot(page);
  assert.equal(await page.locator('#route-length').textContent(), `Test route ${new Intl.NumberFormat('de', {useGrouping:false,minimumFractionDigits:2,maximumFractionDigits:2}).format(beforeDelete.measurements.totalMeters)}`);
  await page.waitForFunction(() => [...document.querySelectorAll('.distance-labels span')].some(label => /^Test segment \d+,\d{2}$/.test(label.textContent)));
  await page.locator('#delete-route').click();
  assert.equal(await page.locator('#delete-route-message').textContent(), 'Test delete 2');
  assert.equal(await page.locator('#cancel-delete-route').textContent(), 'Test cancel');
  await page.locator('#cancel-delete-route').click();
  assert.equal((await snapshot(page)).markers.length, 3);
  await page.evaluate(async () => { const {controller:c}=await import('/app.js'); await c.loadFile({name:'invalid.ply',size:0}); });
  assert.equal(await page.locator('#scene-error').textContent(), 'Test file');
  report.checks.push('Calibration hints/errors, decimal formatting/segment labels, default names, untouched user content, save status, color hints and delete dialog use the same test locale');
  await context.close();
  assert.deepEqual(report.errors, []);
} finally {
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2) + '\n');
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify(report, null, 2));
