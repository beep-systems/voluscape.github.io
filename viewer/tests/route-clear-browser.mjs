import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from '../scripts/serve.mjs';
import { gaussianPly } from './fixtures.mjs';
const require = createRequire(import.meta.url);
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? require.resolve('playwright')));
const output = new URL('../../build/viewer-route-clear-browser/', import.meta.url);
await mkdir(output, { recursive: true });
const server = await createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true, ...(process.env.PREVIEW_BROWSER ? { executablePath: process.env.PREVIEW_BROWSER } : {}) });
const report = { checks: [], errors: [], scope: 'Synthetic route clearing and modal checks; no real-scene quality evidence.' };
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
try {
  for (const renderer of ['webgl', 'webgpu']) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    page.on('pageerror', e => report.errors.push(String(e)));
    await page.goto('http://127.0.0.1:' + server.address().port + '/' + (renderer === 'webgl' ? '?webgl' : ''));
    assert.equal(await page.locator('#delete-route').isDisabled(), true);
    await page.locator('#scene-file').setInputFiles(payload);
    await page.waitForFunction(() => document.querySelector('#scene-host').dataset.status === 'ready');
    await page.evaluate(async () => { window.c = (await import('/app.js')).controller; });
    assert.equal(await page.locator('#delete-route').isDisabled(), true);
    const a = await project(page, [-.8, 0, .16]), b = await project(page, [.8, 0, -.16]);
    for (const [i, tool] of ['route-mode', 'reference-mode', 'route-mode'].entries()) {
      await page.locator('#' + tool).click();
      await page.mouse.click(i === 2 ? b.x : a.x, i === 2 ? b.y : a.y);
      await page.waitForFunction(n => window.c.markers.length === n, i + 1);
    }
    await page.evaluate(() => { window.c.updateMarker(2, { name: 'Spring', note: 'Water', color: 'blue' }); });
    await page.locator('#set-scale').click();
    await page.mouse.click(a.x, a.y); await page.waitForFunction(() => window.c.measurements.points.length === 1);
    await page.mouse.click(b.x, b.y); await page.locator('#scale-distance').fill('4'); await page.locator('#scale-distance').press('Enter');
    await page.evaluate(() => window.c.session.markers.select(2));
    await page.locator('#marker-note').fill('Keep unsaved reference draft');
    const snapshot = await page.evaluate(() => ({ markers: window.c.markers, selected: window.c.state.selectedMarkerId, measurements: window.c.measurements, mode: window.c.state.interactionMode, pose: Array.from(window.c.viewer.app.root.findComponents('camera')[0].entity.getWorldTransform().data) }));
    const layout = await page.locator('#route-tools').evaluate(group => {
      const [scale, remove] = [...group.children].map(e => e.getBoundingClientRect());
      return { gap: remove.left - scale.right, top: remove.top - scale.top, inner: getComputedStyle(group.children[0]).borderTopRightRadius };
    });
    assert.deepEqual(layout, { gap: 0, top: 0, inner: '0px' });
    await page.locator('#delete-route').click();
    assert.equal(await page.locator('#delete-route-message').textContent(), 'Delete all 2 route points? Reference points will be kept.');
    assert.equal(await page.locator('#cancel-delete-route').evaluate(e => e === document.activeElement), true);
    assert.equal(await page.evaluate(() => window.c.viewer.state.inputEnabled), false);
    await page.keyboard.press('f'); await page.keyboard.press('r'); await page.keyboard.press('Delete');
    assert.deepEqual(await page.evaluate(() => Array.from(window.c.viewer.app.root.findComponents('camera')[0].entity.getWorldTransform().data)), snapshot.pose);
    await page.keyboard.press('Enter'); // Default focused Cancel.
    assert.equal(await page.locator('#delete-route-dialog').evaluate(d => d.open), false);
    assert.deepEqual((await page.evaluate(() => window.c.markers)), snapshot.markers);
    assert.equal(await page.locator('#marker-note').inputValue(), 'Keep unsaved reference draft');
    assert.equal(await page.evaluate(() => window.c.viewer.state.inputEnabled), true);
    await page.locator('#delete-route').click(); await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.c.state.interactionMode), snapshot.mode);
    await page.locator('#delete-route').click();
    await page.screenshot({ path: fileURLToPath(new URL(renderer + '-dialog.png', output)) });
    await page.locator('#confirm-delete-route').click();
    assert.deepEqual(await page.evaluate(() => window.c.markers), [snapshot.markers[1]]);
    assert.equal(await page.evaluate(() => window.c.state.selectedMarkerId), 2);
    assert.equal(await page.locator('#marker-note').inputValue(), 'Keep unsaved reference draft');
    assert.deepEqual(await page.evaluate(() => window.c.measurements.calibration), snapshot.measurements.calibration);
    assert.equal(await page.locator('#route-length').textContent(), 'Route: 0.00 m');
    assert.equal(await page.evaluate(() => window.c.session.markers.connections.length), 0);
    assert.equal(await page.locator('#delete-route').isDisabled(), true);
    // Clearing a selected route preserves an unfinished calibration and its input draft.
    await page.locator('#route-mode').click(); await page.mouse.click(b.x, b.y);
    await page.waitForFunction(() => window.c.markers.length === 2);
    await page.locator('#set-scale').click();
    await page.mouse.click(a.x, a.y); await page.waitForFunction(() => window.c.measurements.points.length === 1);
    await page.mouse.click(b.x, b.y); await page.locator('#scale-distance').fill('8');
    const draft = await page.evaluate(() => window.c.measurements.points);
    await page.locator('#delete-route').click(); await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.c.state.interactionMode), 'calibrate-scale');
    await page.locator('#delete-route').click(); await page.locator('#confirm-delete-route').click();
    assert.deepEqual(await page.evaluate(() => window.c.measurements.points), draft);
    assert.equal(await page.locator('#scale-distance').inputValue(), '8');
    assert.equal(await page.evaluate(() => window.c.state.selectedMarkerId), null);
    await page.locator('#cancel-scale').click(); assert.equal(await page.locator('#marker-editor').isVisible(), false);
    // A dialog from the previous scene cannot delete markers in its replacement.
    await page.locator('#route-mode').click(); await page.mouse.click(b.x, b.y);
    await page.waitForFunction(() => window.c.markers.length === 2);
    await page.locator('#delete-route').click();
    await page.locator('#scene-file').setInputFiles(payload);
    await page.waitForFunction(() => document.querySelector('#scene-host').dataset.status === 'ready');
    assert.equal(await page.locator('#delete-route-dialog').evaluate(d => d.open), false);
    assert.equal(await page.evaluate(() => window.c.viewer.state.inputEnabled), true);
    await page.locator('#route-mode').click(); const center = await project(page, [0, 0, 0]);
    await page.mouse.click(center.x, center.y); await page.waitForFunction(() => window.c.markers.length === 1);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#delete-route').click();
    const narrow = await page.locator('#delete-route-dialog').evaluate(d => {
      const box = d.getBoundingClientRect(), a = d.querySelector('#confirm-delete-route').getBoundingClientRect(), b = d.querySelector('#cancel-delete-route').getBoundingClientRect();
      return { fits: box.left >= 0 && box.right <= innerWidth && d.scrollWidth <= d.clientWidth, sameRow: a.top === b.top, cancelRight: b.left > a.right };
    });
    assert.deepEqual(narrow, { fits: true, sameRow: true, cancelRight: true });
    await page.screenshot({ path: fileURLToPath(new URL(renderer + '-narrow.png', output)) });
    await page.locator('#confirm-delete-route').click();
    assert.equal(await page.locator('#route-length').textContent(), 'Scale not set');
    report.checks.push(renderer + ': grouped buttons, modal focus/cancel/ESC/keyboard isolation, reference drafts and scale retained, bulk deletion, calibration draft, replacement, narrow layout');
    await page.close();
  }
  assert.deepEqual(report.errors, []);
} finally {
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
  await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
}
console.log(JSON.stringify(report, null, 2));
