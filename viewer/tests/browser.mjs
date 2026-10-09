import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from '../scripts/serve.mjs';
import { gaussianPly, compressedPly, packagedSog } from './fixtures.mjs';
import { framePose } from '../vendor/framing.js';

const require = createRequire(import.meta.url);
const playwright = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? require.resolve('playwright')));
const sharpModule = await import(pathToFileURL(process.env.SHARP_MODULE ?? require.resolve('sharp')));
const { chromium } = playwright.default ?? playwright;
const output = fileURLToPath(new URL('../../build/viewer-browser/', import.meta.url));
await mkdir(output, { recursive: true });
const server = await createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true,
  ...(process.env.PREVIEW_BROWSER ? { executablePath: process.env.PREVIEW_BROWSER } : {}) });
const ply = gaussianPly(), sog = await packagedSog(sharpModule.default);
const report = { browser: browser.version(), scope: 'Synthetic renderer/lifecycle checks; no reconstruction quality or physical-phone evidence.', checks: [], errors: [] };
const payload = (buffer = ply, name = 'ground.ply') => ({ name, mimeType: 'application/octet-stream', buffer });
const controller = (page, action, value) => page.evaluate(async ({ action, value }) => {
  const { controller } = await import('/app.js');
  if (action === 'snapshot') return { state: controller.state, transformation: controller.transformation,
    renderer: controller.viewer?.app.graphicsDevice.deviceType,
    position: controller.viewer ? (()=>{const p=controller.viewer.app.root.findComponents('camera')[0].entity.getPosition();return [p.x,p.y,p.z];})() : null,
    fov:controller.viewer?.app.root.findComponents('camera')[0].fov,
    width:controller.viewer?.app.graphicsDevice.width,height:controller.viewer?.app.graphicsDevice.height };
  return controller[action](value);
}, { action, value });
const ready = page => page.waitForFunction(() => document.getElementById('scene-host').dataset.status === 'ready', null, { timeout: 30000 });
const open = async (page, file = payload()) => { await page.locator('#scene-file').setInputFiles(file); await ready(page); };
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => report.errors.push(error.message));
  const requests = [];
  page.on('request', request => requests.push({ url: request.url(), method: request.method() }));
  await page.goto(base + '?webgl');
  await page.locator('#open-scene').waitFor();
  assert.equal(await page.locator('canvas').count(), 0);
  await open(page);
  assert.equal((await controller(page,'snapshot')).renderer, 'webgl2');
  assert.equal(await page.locator('#auto-level').isEnabled(), true);
  const initial = (await controller(page,'snapshot')).transformation;
  for (let index = 0; index < 3; index++) {
    await page.locator('#auto-level').uncheck(); await page.locator('#auto-level').check();
    await page.locator('#display-rotation').uncheck(); await page.locator('#display-rotation').check();
  }
  assert.deepEqual((await controller(page,'snapshot')).transformation, initial);
  await page.screenshot({ path: `${output}/desktop-ply.png` });
  report.checks.push('Real WebGL PLY rendering; reliable leveling; repeated orientation switches without drift');
  await page.mouse.move(700,450); await page.mouse.down();
  await page.mouse.move(850,530,{steps:10}); await page.mouse.up();
  await page.waitForTimeout(300);
  assert.notDeepEqual((await controller(page,'snapshot')).position, framePose(initial.bounds,[2,2,-2],85,1440,900).position);
  await page.locator('#fit-scene').click();
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(200); // Let ResizeObserver update the camera viewport.
  await page.locator('#fit-scene').click();
  await page.waitForTimeout(1000); // Upstream frame commands animate camera transitions.
  const portrait = await controller(page,'snapshot');
  const expected = framePose(portrait.transformation.bounds,[2,2,-2],portrait.fov,portrait.width,portrait.height,1.1);
  assert.ok(portrait.position.every((value,axis)=>Math.abs(value-expected.position[axis])<1e-3));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({path:`${output}/portrait-ply.png`});
  report.checks.push('Navigation, Fit scene and portrait resize');
  await open(page); // same file can be selected again
  await open(page,payload(compressedPly(),'ground.compressed.ply'));
  assert.equal((await controller(page,'snapshot')).state.filename,'ground.compressed.ply');
  report.checks.push('Real compressed PLY parse/render');
  await open(page,payload(sog,'ground.sog'));
  assert.equal((await controller(page,'snapshot')).state.filename,'ground.sog');
  assert.equal(await page.locator('#auto-level').isEnabled(),true);
  await page.screenshot({path:`${output}/sog.png`});
  report.checks.push('Same-file reselect and real packaged SOG texture decode/render');
  await page.locator('#close-scene').click();
  assert.equal(await page.locator('canvas').count(),0);
  await page.evaluate(async bytes => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)],'dropped.ply'));
    document.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));
  },Array.from(ply));
  await ready(page);
  assert.equal((await controller(page,'snapshot')).state.filename,'dropped.ply');
  await page.locator('#scene-file').setInputFiles(payload(Buffer.from('broken'),'broken.ply'));
  await page.locator('#scene-error').waitFor({state:'visible'});
  await page.waitForFunction(() => !document.querySelector('canvas'));
  await open(page);
  report.checks.push('Close, drag/drop and corrupted-file recovery');
  // Deterministically hold initialization, then replace/close while awaiting the handle.
  await page.evaluate(async bytes => {
    const {controller} = await import('/app.js');
    const original = controller.createViewer;
    let release;
    controller.createViewer = async options => { await new Promise(resolve => {release=resolve;}); return original(options); };
    const first = controller.loadFile(new File([new Uint8Array(bytes)],'pending.ply'));
    await Promise.resolve();
    const second = controller.loadFile(new File([new Uint8Array(bytes)],'replacement.ply'));
    controller.createViewer = original;
    release(); await first; await second;
  },Array.from(ply));
  await ready(page);
  assert.equal((await controller(page,'snapshot')).state.filename,'replacement.ply');
  assert.equal(await page.locator('canvas').count(),1);
  await page.evaluate(async bytes => {
    const {controller} = await import('/app.js');
    const opening = controller.loadFile(new File([new Uint8Array(bytes)],'closed.ply'));
    controller.closeScene(); await opening;
  },Array.from(ply));
  assert.equal(await page.locator('canvas').count(),0);
  report.checks.push('Replacement during delayed initialization and close during load');
  assert.ok(requests.every(request => request.method === 'GET' && (request.url.startsWith(base)||request.url.startsWith('blob:'))));
  report.checks.push('No uploads or remote scene requests');
  await page.goto(base);
  await open(page);
  const defaultSnapshot = await controller(page,'snapshot');
  const renderer = defaultSnapshot.renderer;
  assert.ok(['webgpu','webgl2'].includes(renderer), `Unexpected renderer ${renderer}`);
  report.checks.push(`Default renderer: ${renderer}${renderer === 'webgl2' ? ' (WebGPU unavailable; engine fallback)' : ''}`);
  await open(page,payload(sog,'default-renderer.sog'));
  assert.equal((await controller(page,'snapshot')).renderer,renderer);
  report.checks.push('Packaged SOG on default renderer');
  await page.close();
  const mobile = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  page = await mobile.newPage();
  page.on('pageerror',error=>report.errors.push(error.message));
  await page.goto(base+'?webgl'); await open(page);
  await page.locator('#fit-scene').tap();
  const beforeTouch = (await controller(page,'snapshot')).position;
  const cdp = await mobile.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x:100,y:280},{id:2,x:250,y:280}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x:70,y:310},{id:2,x:280,y:310}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await cdp.detach();
  await page.waitForTimeout(300);
  assert.notDeepEqual((await controller(page,'snapshot')).position,beforeTouch);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:`${output}/touch.png`});
  await page.locator('#close-scene').tap();
  assert.equal(await page.locator('canvas').count(),0);
  report.checks.push('Touch emulation: controls, two-finger gesture dispatch, responsive layout and close');
  await page.close();
  page = await browser.newPage();
  page.on('pageerror',error=>report.errors.push(error.message));
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type,...args) {
      return type.startsWith('webgl') ? null : original.call(this,type,...args);
    };
  });
  await page.goto(base+'?webgl');
  await page.locator('#scene-file').setInputFiles(payload());
  await page.locator('#scene-error').waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('canvas'));
  assert.equal((await controller(page,'snapshot')).state.status,'error');
  report.checks.push('Unavailable graphics context shows a recoverable error and disposes the failed host');
  assert.deepEqual(report.errors,[]);
  console.log(JSON.stringify(report,null,2));
} finally {
  await writeFile(`${output}/report.json`,JSON.stringify(report,null,2)+'\n');
  await browser.close(); server.closeAllConnections(); server.close();
}
