import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from '../scripts/serve.mjs';
import { gaussianPly } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? require.resolve('playwright')));
const output = fileURLToPath(new URL(`../../build/viewer-top-controls-browser/${new Date().toISOString().replaceAll(':', '-')}/`, import.meta.url));
await mkdir(output, { recursive: true });
const server = await createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true, ...(process.env.PREVIEW_BROWSER ? { executablePath: process.env.PREVIEW_BROWSER } : {}) });
const report = { browser: browser.version(), checks: [], errors: [] };
const payload = { name: 'toolbar.ply', mimeType: 'application/octet-stream', buffer: gaussianPly() };
const ready = page => page.waitForFunction(() => document.querySelector('#scene-host').dataset.status === 'ready');
const activity = page => page.evaluate(async () => (await import('/app.js')).controller.viewer.events.fire('inputEvent', 'uiActivity'));
const enterFullscreen = async page => {
  await activity(page);
  await page.locator('.sse-enterFullscreen').click();
  await page.waitForFunction(() => {
    const root = document.fullscreenElement;
    return root?.classList.contains('sse-viewer') &&
      ['scene-tools', 'scene-controls', 'delete-route-dialog'].every(id => root.contains(document.getElementById(id)));
  });
  assert.equal(await page.locator('#open-scene').isVisible(), true);
  assert.equal(await page.locator('#toolbar').isVisible(), true);
};
const restored = async page => {
  await page.waitForFunction(() => !document.fullscreenElement &&
    ['scene-tools', 'scene-controls', 'delete-route-dialog'].every(id => document.getElementById(id)?.parentNode === document.body));
};
const summaryMatchesToolbar = async page => {
  assert.equal(await page.evaluate(() => {
    const summary = document.querySelector('#measurement-summary');
    const toolbar = document.querySelector('#toolbar');
    return ['top-dimmed', 'top-faded-out'].every(name => summary.classList.contains(name) === toolbar.classList.contains(name)) &&
      summary.inert === toolbar.inert && getComputedStyle(summary).visibility === getComputedStyle(toolbar).visibility;
  }), true, 'Route summary follows toolbar visibility and input state');
};
const idle = async page => {
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(700, 450);
  await activity(page);
};
try {
  for (const suffix of ['?webgl', '']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(base + suffix);
    assert.equal(await page.locator('#open-scene').isVisible(), true);
    await page.locator('#scene-file').setInputFiles(payload); await ready(page);
    await page.keyboard.press('h');
    const renderer = await page.evaluate(async () => (await import('/app.js')).controller.viewer.app.graphicsDevice.deviceType);
    const layout = await page.locator('#interaction-modes button').evaluateAll(buttons => buttons.map(button => {
      const s = getComputedStyle(button), r = button.getBoundingClientRect();
      return { width: r.width, height: r.height, left: r.left, right: r.right,
        tl: s.borderTopLeftRadius, tr: s.borderTopRightRadius,
        transition: s.transitionProperty, duration: s.transitionDuration };
    }));
    assert.ok(layout.every(item => item.width === 44 && item.height === 44 && item.duration === '0.1s' && item.transition === 'background-position'));
    assert.deepEqual(layout.map(item => [item.tl, item.tr]), [['4px', '0px'], ['0px', '0px'], ['0px', '4px']]);
    assert.equal(layout[0].right, layout[1].left); assert.equal(layout[1].right, layout[2].left);
    // Route enters from Edit on the left, and from Reference on the right.
    await page.waitForTimeout(130);
    assert.equal(await page.locator('#route-mode').evaluate(button => getComputedStyle(button).backgroundPosition), '200% 0%');
    for (const id of ['route-mode', 'reference-mode', 'edit-mode', 'reference-mode', 'route-mode', 'edit-mode']) {
      await page.locator(`#${id}`).click();
      await page.waitForTimeout(130);
      assert.equal(await page.locator(`#${id}`).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator(`#${id}`).evaluate(button => getComputedStyle(button).backgroundPosition), '100% 0%');
      if (id !== 'route-mode') {
        assert.equal(await page.locator('#route-mode').evaluate(button => getComputedStyle(button).backgroundPosition), id === 'edit-mode' ? '200% 0%' : '0% 0%');
      }
    }
    await page.screenshot({ path: `${output}/${renderer}-segments.png` });
    // Leave the clicked button focused: mouse focus must not hold or restart fading.
    assert.equal(await page.locator('#edit-mode').evaluate(button => document.activeElement === button && !button.matches(':focus-visible')), true);
    await page.mouse.move(700, 450);
    await page.waitForFunction(() => document.querySelector('#toolbar').classList.contains('top-dimmed'));
    await summaryMatchesToolbar(page);
    assert.equal(await page.locator('.sse-controlsWrap').evaluate(el => el.classList.contains('sse-dimmed')), true);
    await page.waitForFunction(() => document.querySelector('#toolbar').classList.contains('top-faded-out'));
    assert.equal(await page.locator('#toolbar').evaluate(el => el.inert), true);
    assert.equal(await page.locator('#scene-tools').evaluate(el => el.inert), true);
    await page.waitForTimeout(550);
    assert.equal(await page.locator('#toolbar').isVisible(), false);
    assert.equal(await page.locator('#measurement-summary').isVisible(), false);
    await summaryMatchesToolbar(page);
    await page.screenshot({ path: `${output}/${renderer}-hidden.png` });
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => !document.querySelector('#toolbar').inert);
    await summaryMatchesToolbar(page);
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('#scene-tools, #toolbar')), true);
    await page.waitForTimeout(6100);
    assert.equal(await page.locator('#toolbar').isVisible(), true, 'Keyboard focus holds visibility');
    await page.locator('#edit-mode').hover();
    await page.evaluate(() => document.activeElement.blur());
    await activity(page); await page.waitForTimeout(6100);
    assert.equal(await page.locator('#toolbar').isVisible(), true, 'Top hover holds visibility');
    await page.locator('#measurement-summary').hover();
    await activity(page); await page.waitForTimeout(6100);
    await summaryMatchesToolbar(page);
    assert.equal(await page.locator('#measurement-summary').isVisible(), true, 'Summary hover holds visibility');
    await page.locator('#set-scale').click();
    await idle(page); await page.waitForTimeout(6100);
    await summaryMatchesToolbar(page);
    assert.equal(await page.locator('#measurement-summary').isVisible(), true, 'Calibration holds visibility');
    await page.locator('#cancel-scale').click();
    await page.locator('#route-mode').click();
    await page.evaluate(async () => {
      const { controller: c } = await import('/app.js');
      const camera = c.viewer.app.root.findComponents('camera')[0];
      const component = c.viewer.app.root.findComponents('gsplat')[0];
      const p = component.entity.getPosition().clone().set(0, 0, 0);
      component.entity.getWorldTransform().transformPoint(p, p);
      const screen = camera.worldToScreen(p);
      window.toolbarPoint = { x: screen.x, y: screen.y };
    });
    const point = await page.evaluate(() => window.toolbarPoint);
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => !document.querySelector('#marker-editor').hidden);
    await page.locator('#marker-name').fill('Toolbar draft');
    await idle(page); await page.waitForTimeout(6100);
    assert.equal(await page.locator('#marker-editor').isVisible(), true);
    assert.equal(await page.locator('#toolbar').isVisible(), true, 'Open editor holds visibility');
    await summaryMatchesToolbar(page);
    await page.locator('#marker-name').focus();
    await page.evaluate(async () => (await import('/app.js')).controller.viewer.requestFullscreen());
    await page.waitForFunction(() => document.fullscreenElement?.contains(document.querySelector('#scene-controls')));
    assert.equal(await page.locator('#marker-name').inputValue(), 'Toolbar draft');
    assert.equal(await page.locator('#marker-name').evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('#marker-editor').isVisible(), true);
    assert.equal(await page.locator('#save-marker').evaluate(el => el.getBoundingClientRect().width), 120);
    await page.locator('#marker-note').fill('Fullscreen draft');
    await page.screenshot({ path: `${output}/${renderer}-fullscreen-editor.png` });
    await page.locator('.sse-exitFullscreen').click(); await restored(page);
    assert.equal(await page.locator('#marker-name').inputValue(), 'Toolbar draft');
    assert.equal(await page.locator('#marker-note').inputValue(), 'Fullscreen draft');
    await enterFullscreen(page);
    await page.locator('#delete-route').click();
    assert.equal(await page.locator('#delete-route-dialog').isVisible(), true);
    assert.equal(await page.locator('#cancel-delete-route').evaluate(el => el === document.activeElement), true);
    await page.locator('#cancel-delete-route').click();
    assert.equal(await page.locator('#marker-note').inputValue(), 'Fullscreen draft');
    await page.locator('#set-scale').click();
    assert.equal(await page.locator('#scale-editor').isVisible(), true);
    await page.locator('#cancel-scale').click();
    // Headless keyboard events reach upstream Escape handling through a button;
    // form fields intentionally isolate their keyboard events from camera input.
    await page.locator('#edit-mode').click();
    await page.keyboard.press('Escape'); await restored(page);
    assert.equal(await page.locator('#marker-editor').isVisible(), false);
    assert.equal(await page.locator('#marker-note').inputValue(), 'Fullscreen draft');
    await idle(page);
    await page.waitForFunction(() => document.querySelector('#toolbar').classList.contains('top-faded-out'));
    await activity(page);
    await page.waitForFunction(() => !document.querySelector('#toolbar').inert);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('#edit-mode').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    assert.equal(await page.locator('#toolbar').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    assert.equal(await page.locator('#measurement-summary').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${output}/${renderer}-narrow.png` });
    assert.equal(await page.locator('#toolbar').evaluate(el => el.getBoundingClientRect().right <= innerWidth), true);
    await enterFullscreen(page);
    assert.equal(await page.locator('#toolbar').evaluate(el => el.getBoundingClientRect().right <= innerWidth), true);
    await page.screenshot({ path: `${output}/${renderer}-fullscreen-narrow.png` });
    await page.locator('#scene-file').setInputFiles(payload); await ready(page);
    await restored(page);
    await enterFullscreen(page);
    await page.locator('#close-scene').click();
    await restored(page);
    assert.equal(await page.locator('#open-scene').isVisible(), true);
    assert.equal(await page.locator('#scene-tools').evaluate(el => el.inert), false);
    assert.equal(await page.locator('#measurement-summary').isVisible(), false);
    assert.equal(await page.locator('#measurement-summary').evaluate(el => el.inert), false);
    await page.locator('#scene-file').setInputFiles(payload); await ready(page);
    await enterFullscreen(page);
    await page.locator('#scene-file').setInputFiles({ name: 'broken.ply', mimeType: 'application/octet-stream', buffer: Buffer.from('invalid ply') });
    await page.waitForFunction(() => document.querySelector('#scene-host').dataset.status === 'error');
    await restored(page);
    assert.equal(await page.locator('#open-scene').isVisible(), true);
    assert.equal(await page.locator('#scene-error').isVisible(), true);
    report.checks.push(`${renderer}: native fullscreen entry/button exit/Escape/re-entry, both top panels, focused editor and drafts, calibration and modal Cancel, narrow layout, replacement/close/load failure restore`);
    report.checks.push(`${renderer}: segmented corners, sliding highlights, upstream dim/hide with route summary, hidden inert controls, Tab/toolbar and summary hover/editor/calibration protection, reduced motion, narrow viewport and scene replacement/close`);
    await page.close();
  }
  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await touch.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(base + '?webgl');
  await page.locator('#scene-file').setInputFiles(payload); await ready(page);
  await page.keyboard.press('h');
  await page.locator('#reference-mode').tap();
  assert.equal(await page.locator('#reference-mode').getAttribute('aria-pressed'), 'true');
  await page.locator('#edit-mode').tap();
  await page.evaluate(() => document.activeElement?.blur());
  await activity(page);
  await page.waitForFunction(() => document.querySelector('#toolbar').classList.contains('top-faded-out'));
  await summaryMatchesToolbar(page);
  await page.touchscreen.tap(195, 600);
  await page.waitForFunction(() => !document.querySelector('#toolbar').inert);
  await summaryMatchesToolbar(page);
  await page.screenshot({ path: `${output}/touch-restored.png` });
  report.checks.push('Touch: mode taps and scene tap restores hidden controls and route summary');
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close(); server.closeAllConnections(); server.close();
}
