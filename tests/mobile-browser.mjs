import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createServer } from '../scripts/serve.mjs';
const require = createRequire(import.meta.url);
const { chromium } = (await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? require.resolve('playwright')))).default;
const root = process.env.PREVIEW_SITE_ROOT ?? fileURLToPath(new URL('../dist/', import.meta.url));
const output = process.env.PREVIEW_TEST_OUTPUT ?? fileURLToPath(new URL('../build/mobile/', import.meta.url));
await mkdir(output, { recursive: true });
const server = await createServer(root);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PREVIEW_BROWSER ? { executablePath: process.env.PREVIEW_BROWSER } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' });
  context.setDefaultTimeout(20000);
  let page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto(base);
  await page.waitForFunction(() => !document.getElementById('test-select').disabled);
  assert.equal(requests.some(url => /\.(mp4|sog)(\?|$)/.test(url)), false, 'initial page must not fetch heavy media');
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const boxes = await page.locator('.panel').evaluateAll(elements => elements.map(element => ({ x: element.offsetLeft, y: element.offsetTop })));
    if (width <= 820) { assert.equal(boxes[0].x, boxes[1].x); assert.ok(boxes[1].y > boxes[0].y); }
    else assert.ok(boxes[1].x > boxes[0].x);
    await page.screenshot({ path: `${output}/layout-${width}.png`, fullPage: true });
  }
  console.log('PASS: no initial heavy downloads; 320/390/768/1440 layouts');
  await page.close();
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('#open-scene').tap();
  await page.locator('iframe').scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.getElementById('scene-status').textContent.includes('Pinch'), null, { timeout: 20000 }).catch(async error => {
    console.log('Gallery status:', await page.locator('#scene-status').innerText(), 'errors:', await page.locator('#scene-error').textContent());
    console.log('Frames:', await Promise.all(page.frames().map(async frame => ({ url: frame.url(), text: (await frame.locator('body').innerText()).slice(0, 500), state: await frame.evaluate(() => ({ pointer: matchMedia('(pointer: coarse)').matches, orienting: document.documentElement.hasAttribute('data-orienting'), loaded: !!window.app?.root.findComponents('gsplat').length })) }))));
    throw error;
  });
  const iframe = await page.locator('iframe').elementHandle();
  const frame = await iframe.contentFrame();
  await page.locator('iframe').scrollIntoViewIfNeeded();
  const pose = () => frame.evaluate(() => {
    const camera = window.app.root.findComponents('camera')[0];
    const p = camera.entity.getPosition(); return [p.x, p.y, p.z];
  });
  const before = await pose();
  const box = await frame.locator('canvas').boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height * .5;
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  assert.equal(await frame.evaluate(() => { const c = document.querySelector('canvas').getBoundingClientRect(); return document.elementFromPoint(c.width/2, c.height*.5).tagName; }), 'CANVAS', 'touch area must be clear of controls');
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([px, py], id) => ({ x: px, y: py, id, radiusX: 2, radiusY: 2, force: 1 })) });
  await touch('touchStart', [[x, y]]);
  for (let step = 1; step <= 8; step++) { await touch('touchMove', [[x + step * 8, y - step * 3]]); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve))); }
  await touch('touchEnd', []);
  await frame.waitForFunction(previous => {
    const p = window.app.root.findComponents('camera')[0].entity.getPosition();
    return Math.hypot(p.x-previous[0],p.y-previous[1],p.z-previous[2]) > .01;
  }, before);
  console.log('PASS: touch orbit');
  const rotated = await pose();
  await touch('touchStart', [[x - 25, y], [x + 25, y]]);
  for (let step = 1; step <= 6; step++) await touch('touchMove', [[x - 25 - step * 5, y], [x + 25 + step * 5, y]]);
  await touch('touchEnd', []);
  await frame.waitForFunction(previous => {
    const p = window.app.root.findComponents('camera')[0].entity.getPosition();
    return Math.hypot(p.x-previous[0],p.y-previous[1],p.z-previous[2]) > .01;
  }, rotated);
  console.log('PASS: pinch zoom');
  const zoomed = await pose();
  await touch('touchStart', [[x - 25, y], [x + 25, y]]);
  for (let step = 1; step <= 6; step++) await touch('touchMove', [[x - 25, y + step * 4], [x + 25, y + step * 4]]);
  await touch('touchEnd', []);
  await frame.waitForFunction(previous => {
    const p = window.app.root.findComponents('camera')[0].entity.getPosition();
    return Math.hypot(p.x-previous[0],p.y-previous[1],p.z-previous[2]) > .01;
  }, zoomed);
  console.log('PASS: two finger pan');
  const checkButtons = async () => {
    const controls = await frame.locator('button:visible, #level-controls label:visible').evaluateAll(elements => elements.map(element => {
      const b = element.getBoundingClientRect(); return { label: element.textContent.trim() || element.title, width: b.width, height: b.height };
    }).filter(control => control.width > 0 && control.height > 0));
    assert.ok(controls.length > 0);
    for (const control of controls) assert.ok(control.width >= 44 && control.height >= 44, JSON.stringify(control));
    assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  };
  await checkButtons();
  await page.screenshot({ path: `${output}/touch-scene.png`, fullPage: true });
  await page.setViewportSize({ width: 844, height: 390 });
  await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await checkButtons();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#close-scene').scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollTo(0, 0));
  await touch('touchStart', [[12, 650]]);
  for (let step = 1; step <= 8; step++) await touch('touchMove', [[12, 650 - step * 35]]);
  await touch('touchEnd', []);
  await page.waitForFunction(() => scrollY > 0);
  await page.locator('#close-scene').tap();
  assert.equal(await page.locator('iframe').count(), 0);
  console.log('PASS: real SOG on touch emulation: orbit, pinch, pan, orientation, 44px buttons, page scroll, close');
  assert.deepEqual(errors, []);

  const noJS = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await noJS.newPage();
  await staticPage.goto(base);
  assert.equal(await staticPage.locator('h1').count(), 1);
  assert.equal(await staticPage.locator('.scene-list li').count(), 7);
  assert.equal(await staticPage.locator('link[rel="canonical"]').getAttribute('href'), 'https://voluscape.beep.systems/');
  await noJS.close();
  console.log('PASS: built site exposes SEO and seven descriptions without JavaScript');

  const unavailable = await browser.newPage();
  await unavailable.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: undefined });
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      if (/^(webgl2?|experimental-webgl|webgpu)$/.test(type)) return null;
      return original.call(this, type, ...args);
    };
  });
  await unavailable.goto(base);
  await unavailable.locator('#open-scene').click();
  await unavailable.locator('#scene-error').waitFor({ state: 'visible', timeout: 20000 });
  assert.match(await unavailable.locator('#scene-error').innerText(), /Unable to render/);
  assert.equal(await unavailable.locator('video').count(), 1);
  await unavailable.locator('#close-scene').click();
  assert.equal(await unavailable.locator('iframe').count(), 0);
  console.log('PASS: unavailable GPU renderer reports an error; video and close remain usable');
  for (const failure of ['module', 'scene']) {
    const broken = await browser.newPage();
    const uncaught = [];
    broken.on('pageerror', error => uncaught.push(error.message));
    if (failure === 'module') await broken.route('**/viewer/index.js', route => route.fulfill({ status: 404, body: '' }));
    else await broken.route('**/scenes/ch.sog', route => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'invalid scene archive' }));
    await broken.goto(base);
    await broken.locator('#open-scene').click();
    await broken.locator('#scene-error').waitFor({ state: 'visible', timeout: 20000 });
    assert.match(await broken.locator('#scene-error').innerText(), /Unable to render/);
    assert.equal(await broken.locator('video').count(), 1);
    assert.deepEqual(uncaught, []);
    await broken.close();
    console.log(`PASS: ${failure} loading failure reported without an uncaught exception`);
  }
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
