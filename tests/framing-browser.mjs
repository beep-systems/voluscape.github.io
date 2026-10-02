// Optional real-scene regression check. Set PREVIEW_PLY to an existing Gaussian
// PLY path relative to the repo; scenes are served locally and never rewritten.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createServer } from '../scripts/serve.mjs';
import { framePose } from '../viewer/framing.js';

const require = createRequire(import.meta.url);
const { chromium } = (await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? require.resolve('playwright')))).default;
const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.env.PREVIEW_TEST_OUTPUT ?? `${root}/build/framing-real`;
await mkdir(output, { recursive: true });
const server = await createServer(root, { prefix: '/preview' });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/preview/`;
const catalog = JSON.parse(await readFile(new URL('../catalog.json', import.meta.url)));
const scenes = catalog.map(scene => [scene.id, scene.results[0].scene]);
if (process.env.PREVIEW_PLY) scenes.push(['ply', process.env.PREVIEW_PLY.replaceAll('\\', '/')]);
const settings = JSON.parse(await readFile(new URL('../viewer/settings.json', import.meta.url)));
const initial = settings.cameras[0].initial;
const direction = initial.position.map((value, axis) => value - initial.target[axis]);
const sha = async path => createHash('sha256').update(await readFile(`${root}/${path}`)).digest('hex');
const close = (a,b) => a.every((value, axis) => Math.abs(value - b[axis]) < 1e-4 * Math.max(1, Math.abs(b[axis])));
const report = { browser: null, scenes: [], scope: 'Framing/loading/navigation only, not reconstruction quality.' };
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PREVIEW_BROWSER ? { executablePath: process.env.PREVIEW_BROWSER } : {}) });
  report.browser = browser.version();
  for (const [id, path] of scenes) {
    const checksum = await sha(path);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}viewer/embed.html?content=${encodeURIComponent(base + path)}`);
    await page.waitForFunction(() => window.app && !document.documentElement.hasAttribute('data-orienting'), null, { timeout: 60000 });
    const snapshot = () => page.evaluate(() => {
      const camera = window.app.root.findComponents('camera')[0];
      const p = camera.entity.getPosition();
      const forward = camera.entity.forward;
      const depths = [];
      for (const component of window.app.root.findComponents('gsplat')) {
        const bound = component.customAabb;
        const m = component.entity.getWorldTransform().data;
        const lo = bound.getMin(), hi = bound.getMax();
        for (const x of [lo.x,hi.x]) for (const y of [lo.y,hi.y]) for (const z of [lo.z,hi.z]) {
          depths.push((m[0]*x+m[4]*y+m[8]*z+m[12]-p.x)*forward.x +
            (m[1]*x+m[5]*y+m[9]*z+m[13]-p.y)*forward.y +
            (m[2]*x+m[6]*y+m[10]*z+m[14]-p.z)*forward.z);
        }
      }
      return { position: [p.x,p.y,p.z], bounds: window.previewFraming.bounds,
        fullDepth: { min: Math.min(...depths), max: Math.max(...depths) },
        fov: camera.fov, width: window.app.graphicsDevice.width, height: window.app.graphicsDevice.height,
        near: camera.nearClip, far: camera.farClip, renderer: window.app.graphicsDevice.deviceType,
        transforms: window.app.root.findComponents('gsplat').map(c => Array.from(c.entity.getWorldTransform().data)) };
    });
    const waitPose = position => page.waitForFunction(expected => {
      const p = window.app.root.findComponents('camera')[0].entity.getPosition();
      return [p.x,p.y,p.z].every((value, axis) => Math.abs(value - expected[axis]) < 1e-4 * Math.max(1, Math.abs(expected[axis])));
    }, position);
    const opened = await snapshot();
    const expected = framePose(opened.bounds, direction, opened.fov, opened.width, opened.height);
    assert.ok(close(opened.position, expected.position), 'initial camera is framed immediately');
    assert.ok(opened.near > 0 && opened.far > opened.near);
    assert.ok(opened.far >= opened.fullDepth.max - 1e-4, 'far clipping contains transformed full bounds');
    if (opened.fullDepth.min > 0) assert.ok(opened.near <= opened.fullDepth.min + 1e-4);
    await page.screenshot({ path: `${output}/${id}-initial.png` });
    const move = async () => {
      const before = await snapshot();
      await page.mouse.move(700,500);
      await page.mouse.down();
      await page.mouse.move(850,550,{ steps: 12 });
      await page.mouse.up();
      await page.waitForFunction(previous => {
        const p = window.app.root.findComponents('camera')[0].entity.getPosition();
        return Math.hypot(p.x-previous[0],p.y-previous[1],p.z-previous[2]) > .01;
      }, before.position);
    };
    await move();
    await page.screenshot({ path: `${output}/${id}-navigated.png` });
    await page.locator('#fit-scene').click();
    await waitPose(expected.position);
    await page.screenshot({ path: `${output}/${id}-fit.png` });
    await move();
    // The drag already focuses the viewer. A click also starts an asynchronous
    // point-pick transition, which would race an immediately following F.
    await page.keyboard.press('f');
    await waitPose(expected.position);
    const level = page.locator('#auto-level');
    if (await level.isEnabled()) {
      for (let i=0; i<2; i++) {
        await level.uncheck();
        await page.waitForFunction(() => document.documentElement.dataset.levelStatus === 'skipped');
        await level.check();
        await waitPose(expected.position);
        assert.deepEqual((await snapshot()).transforms, opened.transforms);
        assert.deepEqual((await snapshot()).bounds, opened.bounds);
      }
    }
    await page.setViewportSize({ width: 800, height: 1100 });
    await page.waitForFunction(() => window.app.graphicsDevice.width < window.app.graphicsDevice.height);
    const resized = await snapshot();
    assert.ok(close(resized.position, expected.position), 'resize preserves navigation');
    const portrait = framePose(resized.bounds, direction, resized.fov, resized.width, resized.height);
    await page.locator('#fit-scene').click();
    await waitPose(portrait.position);
    await page.screenshot({ path: `${output}/${id}-portrait.png` });
    assert.deepEqual(errors, []);
    assert.equal(await sha(path), checksum);
    report.scenes.push({ id, path, sha256: checksum, opened, portrait: await snapshot(), autoLevel: await level.isEnabled(), errors });
    console.log(`PASS: ${id}: real ${opened.renderer} load, immediate fit, navigation, button/F, level toggles, portrait, immutable input`);
    await page.close();
  }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2) + '\n');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
