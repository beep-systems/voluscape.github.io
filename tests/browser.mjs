// Optional browser verification: npm install --no-save playwright, then node tests/browser.mjs.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createServer } from '../scripts/serve.mjs';
import { framePose } from '../viewer/framing.js';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_MODULE ?? require.resolve('playwright');
const playwright = await import(pathToFileURL(playwrightPath));
const { chromium } = playwright.default ?? playwright;
const root = process.env.PREVIEW_SITE_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
const output = process.env.PREVIEW_TEST_OUTPUT ?? fileURLToPath(new URL('../build/browser/', import.meta.url));
await mkdir(output, { recursive: true });
const server = await createServer(root, { prefix: '/preview' });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/preview/`;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PREVIEW_BROWSER ? { executablePath: process.env.PREVIEW_BROWSER } : {}) });
  console.log(`Browser: Chromium ${browser.version()}`);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator('#test-select').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('test-select').disabled);
  assert.equal(await page.locator('#test-select option').count(), 7);
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await page.locator('#open-scene').isDisabled(), false);
  assert.match(await page.locator('#scene-host').innerText(), /Open scene/);
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  for (const id of ['ch', 'hs', 'qt', 'rd', 'sl', 'tw', 'wh']) {
    await page.selectOption('#test-select', id);
    const dimensions = await page.locator('video').evaluate((video) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Video decode timed out')), 20000);
      video.addEventListener('loadeddata', () => { clearTimeout(timeout); resolve([video.videoWidth, video.videoHeight]); }, { once: true });
      video.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Video decode failed')); }, { once: true });
      video.load();
    }));
    assert.equal(dimensions[0], 1280, id);
    assert.equal(dimensions[1], 720, id);
  }
  console.log('PASS: seven real MP4 files decode at 1280x720; scene available, no initial iframe');
  await page.locator('video').evaluate(async (video) => { video.muted = true; window.previousVideo = video; await video.play(); });
  await page.selectOption('#test-select', 'ch');
  assert.equal(await page.evaluate(() => window.previousVideo.paused && !window.previousVideo.isConnected && !window.previousVideo.hasAttribute('src')), true);
  console.log('PASS: switching tests pauses and unloads the previously playing video');
  await page.goto(base + '#test=qt');
  await page.waitForFunction(() => document.getElementById('test-select').value === 'qt');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('test-select').value === 'qt');
  await page.locator('#test-select').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#test-select').inputValue(), 'rd');
  await page.setViewportSize({ width: 390, height: 844 });
  const layout = await page.locator('.panel').evaluateAll((panels) => panels.map((panel) => {
    const rect = panel.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right };
  }));
  assert.equal(layout[0].x, layout[1].x);
  assert.ok(layout[1].y > layout[0].y && layout.every((panel) => panel.right <= 390));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
  console.log('PASS: direct link, reload, keyboard selection and 390px stacked layout');

  const catalog = JSON.parse(await readFile(new URL('../catalog.json', import.meta.url)));
  catalog[0].results = [
    { id: 'balanced', label: 'Balanced', scene: 'scenes/ch/balanced.sog' },
    { id: 'raw', label: 'Raw', scene: 'scenes/ch/raw.ply' },
    { id: 'missing', label: 'Missing', scene: 'scenes/ch/missing.sog' }
  ];
  await page.route('**/catalog.json', (route) => route.fulfill({ json: catalog }));
  // Stub ONLY viewer lifecycle tests; no reconstruction/renderer evidence claimed.
  await page.route('**/scenes/ch/*', (route) => route.fulfill({ status: route.request().url().includes('missing') ? 404 : 200, body: '' }));
  await page.route('**/viewer/embed.html*', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Lifecycle fixture</title><p>Viewer fixture</p>' }));
  await page.goto(base + '?fixture=variants#test=ch&variant=raw');
  await page.waitForFunction(() => document.getElementById('scene-heading').textContent.includes('Raw'));
  await page.locator('#open-scene').click();
  await page.locator('iframe').waitFor();
  const frameURL = new URL(await page.locator('iframe').getAttribute('src'));
  assert.equal(frameURL.searchParams.get('lang'), 'en');
  assert.ok(frameURL.searchParams.get('content').endsWith('/preview/scenes/ch/raw.ply'));
  assert.ok(frameURL.searchParams.get('settings').endsWith('/preview/viewer/settings.json'));
  await page.evaluate(() => { location.hash = 'test=ch&variant=balanced'; });
  await page.waitForFunction(() => document.getElementById('scene-heading').textContent.includes('Balanced'));
  assert.equal(await page.locator('iframe').count(), 0);
  await page.locator('#open-scene').click();
  await page.locator('iframe').waitFor();
  assert.equal(await page.locator('iframe').count(), 1);
  await page.locator('#close-scene').click();
  assert.equal(await page.locator('iframe').count(), 0);
  await page.evaluate(() => { location.hash = 'test=ch&variant=missing'; });
  await page.waitForFunction(() => document.getElementById('scene-heading').textContent.includes('Missing'));
  await page.locator('#open-scene').click();
  await page.locator('#scene-error').waitFor({ state: 'visible' });
  assert.match(await page.locator('#scene-error').innerText(), /404/);
  assert.equal(await page.locator('video').count(), 1);
  console.log('PASS: variant sharing, iframe replacement/close and missing scene (stubbed lifecycle)');

  await page.route('**/scenes/ch/balanced.sog', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ status: 200, body: '' }).catch(() => {});
  });
  await page.evaluate(() => { location.hash = 'test=ch&variant=balanced'; });
  await page.waitForFunction(() => document.getElementById('scene-heading').textContent.includes('Balanced'));
  await page.locator('#open-scene').click();
  await page.selectOption('#test-select', 'hs');
  await page.waitForTimeout(700);
  assert.equal(await page.locator('iframe').count(), 0);
  assert.match(await page.locator('#scene-host').innerText(), /Open scene/);
  console.log('PASS: stale scene check is aborted when switching tests');

  // Smoke the actual vendored renderer with a tiny synthetic Gaussian PLY.
  // This is not evidence of SOG compatibility or real reconstruction quality.
  await page.unroute('**/viewer/embed.html*');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const properties = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = Buffer.from(['ply', 'format binary_little_endian 1.0', 'element vertex 4', ...properties.map((name) => `property float ${name}`), 'end_header', ''].join('\n'));
  const values = [-0.3,0,0,1,0,0,4,-2,-2,-2,1,0,0,0, 0.3,0,0,0,1,0,4,-2,-2,-2,1,0,0,0,
    0,0.3,0,0,0,1,4,-2,-2,-2,1,0,0,0, 0,-0.3,0,1,1,0,4,-2,-2,-2,1,0,0,0];
  const vertices = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => vertices.writeFloatLE(value, index * 4));
  const ply = Buffer.concat([header, vertices]);
  await page.route('**/scenes/ch/raw.ply', (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: ply }));
  await page.selectOption('#test-select', 'ch');
  await page.evaluate(() => { location.hash = 'test=ch&variant=raw'; });
  await page.waitForFunction(() => document.getElementById('scene-heading').textContent.includes('Raw'));
  await page.locator('#open-scene').click();
  await page.locator('iframe').waitFor();
  // Headless smoke uses WebGL explicitly; default WebGPU is checked later on owner hardware.
  await page.locator('iframe').evaluate((frame) => { const url = new URL(frame.src); url.searchParams.set('webgl', ''); frame.src = url; });
  const actualViewer = await page.locator('iframe').elementHandle();
  const viewerFrame = await actualViewer.contentFrame();
  await viewerFrame.waitForFunction(() => window.app && document.querySelector('.sse-loadingWrap')?.classList.contains('sse-hidden'), null, { timeout: 20000 }).catch(async (error) => {
    console.log('Viewer body:', await viewerFrame.locator('body').innerText());
    console.log('Viewer errors:', errors);
    throw error;
  });
  assert.ok(await viewerFrame.locator('canvas').evaluate((canvas) => canvas.width > 0 && canvas.height > 0));
  await viewerFrame.waitForFunction(() => !document.documentElement.hasAttribute('data-orienting'));
  const up = await viewerFrame.evaluate(() => {
    const entity = window.app.root.findComponents('gsplat')[0].entity;
    return [entity.up.x, entity.up.y, entity.up.z];
  });
  assert.ok(Math.abs(up[0]) < 0.0001 && Math.abs(up[1]) < 0.0001 && Math.abs(up[2] - 1) < 0.0001);
  assert.equal(await viewerFrame.locator('html').getAttribute('data-level-status'), 'skipped');
  assert.equal(await viewerFrame.locator('#auto-level').isDisabled(), true);
  assert.equal(await viewerFrame.locator('#level-status').innerText(), 'No reliable estimate');
  await viewerFrame.locator('#fit-scene').waitFor({ state: 'visible' });
  const framingState = () => viewerFrame.evaluate(() => {
    const camera = window.app.root.findComponents('camera')[0];
    const position = camera.entity.getPosition();
    return { bounds: window.previewFraming.bounds, position: [position.x, position.y, position.z],
      fov: camera.fov, width: window.app.graphicsDevice.width, height: window.app.graphicsDevice.height };
  });
  const initialFrame = await framingState();
  assert.ok(initialFrame.bounds);
  const expectedInitial = framePose(initialFrame.bounds, [2,2,-2], initialFrame.fov, initialFrame.width, initialFrame.height);
  assert.ok(initialFrame.position.every((value, axis) => Math.abs(value - expectedInitial.position[axis]) < 1e-4));
  await viewerFrame.locator('#fit-scene').click();
  await viewerFrame.waitForFunction((expected) => {
    const position = window.app.root.findComponents('camera')[0].entity.getPosition();
    return [position.x, position.y, position.z].every((value, axis) => Math.abs(value - expected[axis]) < 1e-4);
  }, initialFrame.position);
  const beforeResize = await framingState();
  await page.setViewportSize({ width: 700, height: 1000 });
  const resizeDimensions = await page.locator('iframe').evaluate(frame => [frame.clientWidth, frame.clientHeight]);
  await viewerFrame.waitForFunction(([width, height]) => Math.abs(window.app.graphicsDevice.width - width * devicePixelRatio) < 2 && Math.abs(window.app.graphicsDevice.height - height * devicePixelRatio) < 2, resizeDimensions);
  const afterResize = await framingState();
  assert.deepEqual(afterResize.bounds, beforeResize.bounds);
  assert.ok(afterResize.position.every((value, axis) => Math.abs(value - beforeResize.position[axis]) < 1e-4));
  const expectedResize = framePose(afterResize.bounds, [2,2,-2], afterResize.fov, afterResize.width, afterResize.height);
  await viewerFrame.locator('#fit-scene').click();
  await viewerFrame.waitForFunction((expected) => {
    const position = window.app.root.findComponents('camera')[0].entity.getPosition();
    return [position.x, position.y, position.z].every((value, axis) => Math.abs(value - expected[axis]) < 1e-4);
  }, expectedResize.position);
  assert.doesNotMatch(await viewerFrame.locator('body').innerText(), /[\u0400-\u04ff]/);
  await page.screenshot({ path: `${output}/synthetic-ply.png`, fullPage: true });
  await page.selectOption('#test-select', 'hs');
  assert.equal(await page.locator('iframe').count(), 0);
  console.log('PASS: actual pinned WebGL viewer rendered a synthetic four-Gaussian PLY; iframe removed on switch');

  await page.unroute('**/catalog.json');
  await page.route('**/catalog.json', (route) => route.fulfill({ body: '{broken', contentType: 'application/json' }));
  await page.reload();
  await page.locator('#catalog-error').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#test-select').isDisabled(), true);
  await page.unroute('**/catalog.json');
  catalog[0].video = 'web-video/missing.mp4';
  await page.route('**/catalog.json', (route) => route.fulfill({ json: catalog }));
  await page.goto(base + '?fixture=missing-video#test=ch');
  await page.waitForFunction(() => !document.getElementById('test-select').disabled);
  await page.locator('video').evaluate((video) => video.load());
  await page.locator('#video-error').waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
  console.log('PASS: invalid JSON and missing video errors; no uncaught gallery exceptions');
  await page.unroute('**/catalog.json');
  await page.goto(base + '#test=tw');
  await page.waitForFunction(() => document.getElementById('test-select')?.value === 'tw');
  console.log('PASS: root entry under repository prefix preserves selection hash');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
