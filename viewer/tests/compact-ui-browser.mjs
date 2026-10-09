import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from '../scripts/serve.mjs';
import { gaussianPly } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? require.resolve('playwright')));
const output = fileURLToPath(new URL(`../../build/viewer-compact-ui/${new Date().toISOString().replaceAll(':', '-')}/`, import.meta.url));
await mkdir(output, { recursive: true });
const server = await createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.PREVIEW_BROWSER ? { executablePath: process.env.PREVIEW_BROWSER } : {}) });
const report = { browser: browser.version(), checks: [], errors: [] };
try {
  for (const renderer of ['webgl', 'webgpu']) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, hasTouch: true });
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?${renderer}`);
    await page.locator('#scene-file').setInputFiles({ name: 'compact.ply', mimeType: 'application/octet-stream', buffer: gaussianPly() });
    await page.waitForFunction(() => document.querySelector('#scene-host').dataset.status === 'ready');
    report.checks.push(`${renderer}: actual renderer ${await page.evaluate(async () => (await import('/app.js')).controller.viewer.app.graphicsDevice.deviceType)}`);
    for (const [width, height] of [[320,480], [390,440], [600,480], [800,360], [600,481], [601,480], [601,481], [1000,800]]) {
      await page.setViewportSize({ width, height });
      const compact = width <= 600 || height <= 480;
      await page.waitForFunction(expected => document.documentElement.hasAttribute('data-compact-ui') === expected, compact);
      await page.evaluate(async () => (await import('/app.js')).controller.viewer.events.fire('inputEvent', 'uiActivity'));
      const rects = await page.evaluate(() => ['fit-scene', 'compact-more', 'edit-mode', 'route-mode', 'reference-mode'].map(id => {
        const node = document.getElementById(id), r = node.getBoundingClientRect();
        return { id, x: r.x, y: r.y, width: r.width, height: r.height, visible: !!node.getClientRects().length };
      }));
      for (const r of rects.filter(r => r.visible)) {
        assert.ok(r.width >= 44 && r.height >= 44, JSON.stringify(r));
        assert.ok(r.x >= 0 && r.x + r.width <= width && r.y >= 0 && r.y + r.height <= height, JSON.stringify(r));
      }
      if (compact) {
        assert.equal(await page.locator('#open-scene').isVisible(), false);
        await page.locator('#compact-more').tap();
        assert.equal(await page.locator('#open-scene').isVisible(), true);
        assert.equal(await page.locator('#set-scale svg').evaluate(node => node.getBoundingClientRect().width), 24);
        assert.ok((await page.locator('#set-scale').boundingBox()).height <= 48);
        assert.equal(await page.locator('.sse-controlsWrap').evaluate(node => node.inert), true);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#compact-more').getAttribute('aria-expanded'), 'false');
        await page.locator('#compact-more').tap();
        await page.locator('#set-scale').click();
        assert.equal(await page.locator('#compact-menu').isVisible(), false);
        await page.locator('#cancel-scale').click();
      }
      await page.screenshot({ path: `${output}/${renderer}-${width}x${height}.png` });
    }
    // A small container inside a wide page must also select compact mode.
    await page.evaluate(() => document.getElementById('scene-host').style.cssText = 'inset: 20px auto auto 30px; width:390px; height:440px');
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-compact-ui'));
    await page.locator('#compact-more').click();
    await page.keyboard.press('Escape');
    // Deterministic controller pick checks editor policy, not reconstruction quality.
    await page.evaluate(async () => {
      const { controller: c } = await import('/app.js');
      c.setInteractionMode('add-marker');
      const pick = c.viewer.pickSurface;
      try {
        c.viewer.pickSurface = async () => ({ position: [0,0,0], normal: [0,1,0] });
        await c.session.markers.addAt(.5,.5);
      } finally { c.viewer.pickSurface = pick; }
      c.setInteractionMode('edit-markers');
      c.session.markers.select(c.state.selectedMarkerId);
    });
    await page.locator('#marker-name').fill('Retained draft');
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-compact-editor'));
    const sheet = await page.locator('#marker-editor').boundingBox();
    assert.ok(sheet.x >= 30 && sheet.x + sheet.width <= 420 && sheet.y + sheet.height <= 460);
    await page.screenshot({ path: `${output}/${renderer}-embedded-editor.png` });
    await page.evaluate(() => document.getElementById('scene-host').style.cssText = '');
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-compact-ui'));
    assert.equal(await page.locator('#marker-name').inputValue(), 'Retained draft');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width:390, height:440 });
    await page.locator('#compact-fullscreen').click();
    await page.waitForFunction(() => document.fullscreenElement?.contains(document.getElementById('compact-actions')));
    await page.locator('#compact-fullscreen').click();
    await page.waitForFunction(() => !document.fullscreenElement);
    await page.evaluate(async () => {
      const { controller: c } = await import('/app.js'); c.session.markers.select(c.state.selectedMarkerId);
    });
    await page.setViewportSize({ width:800, height:360 });
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-short-ui'));
    assert.equal(await page.locator('#toolbar').isVisible(), false);
    assert.equal(await page.locator('#save-marker').isVisible(), true);
    await page.screenshot({ path: `${output}/${renderer}-short-editor.png` });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width:390, height:440 });
    await page.locator('#compact-more').tap();
    await page.touchscreen.tap(380, 400);
    assert.equal(await page.locator('#compact-menu').isVisible(), false);
    assert.equal(await page.locator('.sse-controlsWrap').evaluate(node => node.inert), false);
    await page.locator('#compact-more').tap();
    await page.screenshot({ path: `${output}/${renderer}-menu.png` });
    await page.locator('#close-scene').click();
    assert.equal(await page.locator('#open-scene').isVisible(), true);
    assert.equal(await page.locator('#compact-menu').isVisible(), false);
    report.checks.push(`${renderer}: breakpoints, touch menu, Escape, scale cancellation, container sizing, sheet bounds, draft retention, fullscreen and panel restoration`);
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close(); server.closeAllConnections(); server.close();
}
