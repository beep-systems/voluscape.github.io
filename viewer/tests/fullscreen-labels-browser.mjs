import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from '../scripts/serve.mjs';
import { gaussianPly } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? require.resolve('playwright')));
const output = fileURLToPath(new URL(`../../build/viewer-fullscreen-labels-browser/${new Date().toISOString().replaceAll(':', '-')}/`, import.meta.url));
await mkdir(output, { recursive: true });
const server = await createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.PREVIEW_BROWSER ? { executablePath: process.env.PREVIEW_BROWSER } : {}) });
const report = { browser: browser.version(), checks: [], errors: [], scope: 'Synthetic scene; actual renderer recorded, no physical-device evidence.' };
const payload = { name: 'labels.ply', mimeType: 'application/octet-stream', buffer: gaussianPly() };
const ready = page => page.waitForFunction(() => document.querySelector('#scene-host').dataset.status === 'ready');
const project = (page, position) => page.evaluate(async position => {
  const { controller: c } = await import('/app.js');
  const component = c.viewer.app.root.findComponents('gsplat')[0];
  const point = component.entity.getPosition().clone().set(...position);
  component.entity.getWorldTransform().transformPoint(point, point);
  const screen = c.viewer.app.root.findComponents('camera')[0].worldToScreen(point);
  return { x: screen.x, y: screen.y };
}, position);
const labelsVisible = async page => {
  await page.waitForFunction(() => {
    const names = [...document.querySelectorAll('.marker-labels .marker-label')];
    const lengths = [...document.querySelectorAll('.distance-labels .marker-label')];
    return names.length === 3 && lengths.length === 1 && [...names, ...lengths].every(el => !el.hidden);
  });
  assert.equal(await page.locator('.marker-labels .marker-label').first().evaluate(el => getComputedStyle(el).padding), '3px 7px');
  assert.equal(await page.locator('.distance-labels .marker-label').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
};
const enter = async page => {
  await page.evaluate(async () => (await import('/app.js')).controller.viewer.events.fire('inputEvent', 'uiActivity'));
  await page.locator('.sse-enterFullscreen').click();
  await page.waitForFunction(() => document.fullscreenElement?.contains(document.querySelector('.marker-labels')) &&
    document.fullscreenElement.contains(document.querySelector('.distance-labels')));
  await labelsVisible(page);
};
try {
  for (const requested of ['webgl', 'webgpu']) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/${requested === 'webgl' ? '?webgl' : ''}`);
    await page.locator('#scene-file').setInputFiles(payload); await ready(page);
    const actual = await page.evaluate(async () => (await import('/app.js')).controller.viewer.app.graphicsDevice.deviceType);
    await page.evaluate(async () => { window.c = (await import('/app.js')).controller; });
    let a = await project(page, [-.8, 0, .16]), b = await project(page, [.8, 0, -.16]);
    await page.locator('#set-scale').click();
    await page.mouse.click(a.x, a.y);
    await page.waitForFunction(() => window.c.measurements.points.length === 1 && !window.c.session.measurements.busy);
    b = await project(page, [.8, 0, -.16]);
    await page.mouse.click(b.x, b.y);
    await page.waitForFunction(() => window.c.measurements.points.length === 2);
    await page.screenshot({ path: `${output}/${requested}-calibration.png` });
    await page.locator('#scale-distance').fill('4');
    await page.locator('#apply-scale').click();
    a = await project(page, [-.8, 0, .16]); b = await project(page, [.8, 0, -.16]);
    for (const [index, point] of [a, b, await project(page, [0, 0, .8])].entries()) {
      await page.locator(index === 2 ? '#reference-mode' : '#route-mode').click();
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction(count => window.c.markers.length === count, index + 1);
      await page.locator('#marker-name').fill(['Route A', 'Route B', 'Information point'][index]);
      await page.locator('#save-marker').click();
      await page.locator('#close-marker-editor').click();
    }
    await page.locator('#edit-mode').click();
    await labelsVisible(page);
    const length = await page.locator('.distance-labels .marker-label').textContent();
    const routeLabel = page.locator('.marker-labels .marker-label').filter({ hasText: 'Route A' });
    await routeLabel.click();
    const selected = await page.evaluate(() => window.c.state.selectedMarkerId);
    await page.locator('#marker-name').fill('Unsaved name');
    await page.locator('#marker-note').fill('Unsaved note');
    for (const field of ['marker-name', 'marker-note', 'marker-type-route']) {
      await page.locator(`#${field}`).press('Escape');
      assert.equal(await page.locator('#marker-editor').isVisible(), false);
      assert.equal(await page.evaluate(() => window.c.state.selectedMarkerId), selected);
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.c.update({}));
      assert.equal(await page.locator('#marker-editor').isVisible(), false);
      await routeLabel.click();
      assert.equal(await page.locator('#marker-editor').isVisible(), true);
      assert.equal(await page.locator('#marker-name').inputValue(), 'Unsaved name');
      assert.equal(await page.locator('#marker-note').inputValue(), 'Unsaved note');
    }
    await page.locator('#close-marker-editor').click();
    report.checks.push({ requested, actual, passed: 'Escape in Edit hides editor from name/note/type button; repeated Escape and rerender keep it closed; selection and drafts survive reopening by label.' });
    for (let cycle = 0; cycle < 2; cycle++) {
      await enter(page);
      assert.equal(await page.locator('.distance-labels .marker-label').textContent(), length);
      for (const name of ['Route A', 'Information point']) {
        const label = page.locator('.marker-labels .marker-label').filter({ hasText: name });
        await label.click();
        assert.equal(await page.locator('#marker-name').inputValue(), name);
        await page.locator('#close-marker-editor').click();
      }
      await labelsVisible(page);
      assert.equal(await page.locator('.distance-labels .marker-label').isVisible(), true);
      await page.screenshot({ path: `${output}/${requested}-${actual}-fullscreen-${cycle}.png` });
      await page.locator('.sse-exitFullscreen').click();
      await page.waitForFunction(() => !document.fullscreenElement);
      if (cycle === 0) await page.setViewportSize({ width: 900, height: 700 });
      await labelsVisible(page);
    }
    await enter(page);
    await page.locator('#scene-file').setInputFiles(payload); await ready(page);
    await page.waitForFunction(() => !document.fullscreenElement);
    assert.equal(await page.locator('.marker-label').count(), 0);
    assert.equal(await page.locator('.marker-labels, .distance-labels').count(), 2);
    await page.locator('.sse-enterFullscreen').click();
    await page.waitForFunction(() => !!document.fullscreenElement);
    await page.locator('#close-scene').click();
    await page.waitForFunction(() => !document.fullscreenElement);
    assert.equal(await page.locator('.marker-labels, .distance-labels').count(), 0);
    report.checks.push({ requested, actual, passed: 'Route/reference names and calibrated segment labels visible in native fullscreen; styles, label selection, resize, unchanged distances, repeated entry/exit, replacement and close cleanup.' });
    await page.close();
  }
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close(); server.closeAllConnections(); server.close();
}
