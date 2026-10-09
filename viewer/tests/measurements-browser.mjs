import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from '../scripts/serve.mjs';
import { gaussianPly } from './fixtures.mjs';
const require = createRequire(import.meta.url);
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? require.resolve('playwright')));
const output = new URL('../../build/viewer-measurements-browser/', import.meta.url);
await mkdir(output, { recursive: true });
const server = await createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true, ...(process.env.PREVIEW_BROWSER ? { executablePath: process.env.PREVIEW_BROWSER } : {}) });
const report = { checks: [], errors: [], scope: 'Synthetic calibration checks, no real-scene metric accuracy evidence.' };
const payload = { name: 'ground.ply', mimeType: 'application/octet-stream', buffer: gaussianPly() };
const state = page => page.evaluate(async () => { const { controller: c } = await import('/app.js'); return { ...c.measurements, mode: c.state.interactionMode, count: c.markers.length, renderer: c.viewer.app.graphicsDevice.deviceType }; });
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
async function assertActions(page, applying) {
  const layout = await page.locator('#scale-actions').evaluate(row => {
    const cancel = row.querySelector('#cancel-scale').getBoundingClientRect();
    const apply = row.querySelector('#apply-scale').getBoundingClientRect();
    return { rightGap: row.getBoundingClientRect().right - cancel.right, cancelTop: cancel.top, applyTop: apply.top, applyRight: apply.right, cancelLeft: cancel.left };
  });
  assert.ok(Math.abs(layout.rightGap) < 1);
  if (applying) { assert.ok(Math.abs(layout.cancelTop - layout.applyTop) < 1); assert.ok(layout.cancelLeft > layout.applyRight); }
}
try {
  for (const renderer of ['webgl', 'webgpu']) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    page.on('pageerror', e => report.errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.address().port}/${renderer === 'webgl' ? '?webgl' : ''}`);
    await page.locator('#scene-file').setInputFiles(payload);
    await page.waitForFunction(() => document.querySelector('#scene-host').dataset.status === 'ready');
    await page.evaluate(async () => { window.c = (await import('/app.js')).controller; });
    const actualRenderer = (await state(page)).renderer;
    if (renderer === 'webgl') assert.equal(actualRenderer, 'webgl2');
    else assert.ok(['webgpu', 'webgl2'].includes(actualRenderer), 'default renderer supports WebGL fallback');
    console.log(`Measurements: requested ${renderer}, actual ${actualRenderer}`);
    const a = await project(page, [-.8, 0, .16]), b = await project(page, [.8, 0, -.16]);
    await page.locator('#set-scale').click();
    await assertActions(page, false);
    await page.mouse.click(15, 700); await page.waitForFunction(() => !window.c.session.measurements.busy); assert.equal((await state(page)).points.length, 0);
    await page.mouse.click(a.x, a.y);
    await page.waitForFunction(() => window.c.measurements.points.length === 1);
    await page.mouse.click(b.x, b.y);
    await page.locator('#scale-distance').waitFor({ state: 'visible' });
    await assertActions(page, true);
    await page.screenshot({ path: fileURLToPath(new URL(renderer + '-actions.png', output)) });
    assert.equal((await state(page)).count, 0);
    await page.locator('#scale-distance').fill('0'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
    assert.equal(await page.locator('#scale-error').isVisible(), true);
    await page.locator('#scale-distance').fill('4,0'); await page.locator('#scale-distance').press('Enter');
    assert.equal((await state(page)).mode, 'edit-markers');
    assert.equal((await state(page)).calibration.meters, 4);
    assert.equal(await page.locator('#route-length').textContent(), 'Route: 0.00 m');
    await page.locator('#route-mode').click();
    await page.mouse.click(a.x, a.y); await page.waitForFunction(() => window.c.markers.length === 1);
    await page.mouse.click(b.x, b.y); await page.waitForFunction(() => window.c.markers.length === 2);
    let before = (await state(page)).totalMeters;
    assert.ok(Math.abs(before - 4) < .15);
    await page.locator('#edit-mode').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.distance-labels .marker-label')].some(e => !e.hidden && e.textContent.endsWith(' m')));
    assert.equal(await page.locator('.distance-labels .marker-label').first().evaluate(e => getComputedStyle(e).pointerEvents), 'none');
    await page.screenshot({ path: fileURLToPath(new URL(renderer + '-lengths.png', output)) });
    await page.evaluate(async () => {
      const { controller: c } = await import('/app.js');
      const id = c.markers[1].id;
      c.updateMarker(id, { type: 'reference' });
      if (c.measurements.totalMeters !== 0 || c.measurements.segments.length !== 0) throw new Error('Reference filtering failed');
      c.updateMarker(id, { type: 'route' });
    });
    assert.equal((await state(page)).totalMeters, before);
    await page.locator('#set-scale').click(); await page.mouse.click(a.x, a.y);
    await page.waitForFunction(() => window.c.measurements.points.length === 1);
    await page.mouse.click(b.x, b.y); await page.locator('#scale-distance').waitFor({ state: 'visible' });
    await page.locator('#scale-distance').fill('8'); await page.locator('#scale-distance').press('Escape');
    assert.equal((await state(page)).totalMeters, before);
    await page.locator('#set-scale').click(); await page.mouse.click(a.x, a.y);
    await page.waitForFunction(() => window.c.measurements.points.length === 1);
    await page.mouse.click(b.x, b.y); await page.locator('#scale-distance').waitFor({ state: 'visible' });
    await page.locator('#scale-distance').fill('8');
    assert.equal((await state(page)).totalMeters, before);
    await page.locator('#apply-scale').click();
    assert.ok(Math.abs((await state(page)).totalMeters - before * 2) < .02);
    before = (await state(page)).totalMeters;
    await page.evaluate(async () => { const { controller: c } = await import('/app.js'); c.setDisplayRotation(false); c.setAutoLevel(false); });
    assert.equal((await state(page)).totalMeters, before);
    await page.locator('#set-scale').click();
    await page.evaluate(async () => {
      const { controller: c } = await import('/app.js');
      c.viewer.pickSurface = () => new Promise(resolve => { window.pendingPick = resolve; });
      void c.session.measurements.pick(100, 100);
      c.cancelScaleCalibration(); window.pendingPick({ position: [1, 2, 3] });
    });
    assert.equal((await state(page)).points.length, 0);
    await page.evaluate(async () => {
      const { controller: c } = await import('/app.js');
      c.beginScaleCalibration();
      const camera = c.viewer.app.root.findComponents('camera')[0].entity;
      window.poseBefore = Array.from(camera.getWorldTransform().data);
    });
    await page.mouse.move(400, 500); await page.mouse.down(); await page.mouse.move(440, 520, { steps: 8 }); await page.mouse.up();
    await page.waitForFunction(() => window.poseBefore.some((v, i) => v !== window.c.viewer.app.root.findComponents('camera')[0].entity.getWorldTransform().data[i]));
    assert.equal((await state(page)).points.length, 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#reset-scale').count(), 0);
    assert.equal((await state(page)).totalMeters, before);
    await page.locator('#scene-file').setInputFiles(payload);
    await page.waitForFunction(() => document.querySelector('#scene-host').dataset.status === 'ready');
    assert.equal((await state(page)).calibration, null); assert.equal((await state(page)).count, 0);
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#set-scale').click();
    assert.equal(await page.locator('#scale-editor').evaluate(e => e.getBoundingClientRect().right <= innerWidth && e.scrollWidth <= e.clientWidth), true);
    await assertActions(page, false);
    const narrowA = await project(page, [-.8, 0, .16]), narrowB = await project(page, [.8, 0, -.16]);
    await page.mouse.click(narrowA.x, narrowA.y); await page.waitForFunction(() => window.c.measurements.points.length === 1);
    await page.mouse.click(narrowB.x, narrowB.y); await page.locator('#scale-distance').waitFor({ state: 'visible' });
    await assertActions(page, true);
    await page.screenshot({ path: fileURLToPath(new URL(renderer + '-narrow-actions.png', output)) });
    await page.locator('#cancel-scale').click(); assert.equal((await state(page)).calibration, null);
    report.checks.push(`${renderer} (actual ${actualRenderer}): real surface clicks, invalid/comma input, passive visible lengths, sum, cancellation, orientation, retained scale, replacement, compact layout`);
    await page.close();
  }
  assert.deepEqual(report.errors, []);
} finally {
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
  await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
}
console.log(JSON.stringify(report, null, 2));
