import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from '../scripts/serve.mjs';
import { gaussianPly } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const module = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? require.resolve('playwright')));
const { chromium } = module.default ?? module;
const sharpModule = await import(pathToFileURL(process.env.SHARP_MODULE ?? require.resolve('sharp')));
const sharp = sharpModule.default;
const output = fileURLToPath(new URL('../../build/viewer-markers-browser/', import.meta.url));
await mkdir(output, { recursive: true });
const server = await createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ headless: true, ...(process.env.PREVIEW_BROWSER ? { executablePath: process.env.PREVIEW_BROWSER } : {}) });
const report = { browser: browser.version(), scope: 'Synthetic marker/navigation/render checks; no physical-phone or reconstruction-quality evidence.', checks: [], errors: [] };
const payload = {name:'marker-ground.ply',mimeType:'application/octet-stream',buffer:gaussianPly()};
const ready = page => page.waitForFunction(()=>document.getElementById('scene-host').dataset.status==='ready');
const snapshot = page => page.evaluate(async () => {
  const {controller:c} = await import('/app.js');
  const camera=c.viewer?.app.root.findComponents('camera')[0].entity;
  const p=camera?.getPosition(), q=camera?.getRotation();
  return { markers:c.markers,state:c.state,pose:p?[p.x,p.y,p.z,q.x,q.y,q.z,q.w]:null,
    renderer:c.viewer?.app.graphicsDevice.deviceType,
    entities:c.viewer?.app.root.findByName('VoluScapeMarker')!=null };
});
async function project(page, position) {
  return page.evaluate(async position => {
    const {controller:c} = await import('/app.js');
    const component=c.viewer.app.root.findComponents('gsplat')[0];
    const point=component.entity.getPosition().clone().set(...position);
    component.entity.getWorldTransform().transformPoint(point,point);
    const camera=c.viewer.app.root.findComponents('camera')[0];
    const screen=camera.worldToScreen(point);
    const rect=document.querySelector('canvas').getBoundingClientRect();
    return {x:screen.x+rect.left,y:screen.y+rect.top};
  },position);
}
async function count(page, expected) {
  await page.waitForFunction(expected=>document.getElementById('marker-count').textContent===`Markers: ${expected}`,expected);
}
async function assertEditorLayout(page) {
  const layout = await page.evaluate(() => {
    const ids = ['marker-editor-header','marker-name-wrap','marker-type-label','marker-type','marker-palette','marker-note','marker-actions'];
    const panel = document.getElementById('marker-editor');
    const save = document.getElementById('save-marker').getBoundingClientRect();
    const status = document.getElementById('marker-save-status').getBoundingClientRect();
    const remove = document.getElementById('delete-marker').getBoundingClientRect();
    return {
      tops: ids.map(id => document.getElementById(id).getBoundingClientRect().top),
      saveWidth: save.width,
      sameRow: Math.abs(save.top-remove.top)<1 && status.left>=save.right && remove.left>=status.right,
      fits: panel.scrollWidth<=panel.clientWidth && panel.getBoundingClientRect().right<=innerWidth,
      buttons: [...document.querySelectorAll('#marker-type button')].map(button => ({
        label: button.getAttribute('aria-label'), title: button.title,
        pressed: button.getAttribute('aria-pressed'), background: getComputedStyle(button).backgroundColor
      }))
    };
  });
  assert.deepEqual(layout.tops,[...layout.tops].sort((a,b)=>a-b));
  assert.equal(layout.saveWidth,120);
  assert.equal(layout.sameRow,true);
  assert.equal(layout.fits,true);
  assert.deepEqual(layout.buttons.map(button=>button.label),['Route point','Reference']);
  assert.ok(layout.buttons.every(button=>button.title===button.label));
  assert.equal(layout.buttons.filter(button=>button.pressed==='true').length,1);
  assert.equal(layout.buttons.find(button=>button.pressed==='true').background,'rgb(255, 102, 0)');
}
async function redPixels(page) {
  const overlays = await page.locator('#marker-editor').evaluateAll(elements => elements.map(element => {
    const { left, right, top, bottom } = element.getBoundingClientRect();
    return { left, right, top, bottom };
  }));
  const { data, info } = await sharp(await page.screenshot()).removeAlpha().raw().toBuffer({resolveWithObject:true});
  let count = 0;
  // Ignore toolbar and upstream controls; the scene fixture itself is pastel.
  for (let y=180;y<info.height-120;y++) for(let x=200;x<info.width-250;x++) {
    if (overlays.some(rect => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom)) continue;
    const index=(y*info.width+x)*info.channels;
    if(data[index]>160 && data[index+1]<80 && data[index+2]<80) count++;
  }
  return count;
}
async function assertUpright(page) {
  const ups = await page.evaluate(async () => {
    const {controller:c} = await import('/app.js');
    return c.session.markers.items.map(({visual}) => {
      const up=visual.entity.up;return [up.x,up.y,up.z];
    });
  });
  assert.ok(ups.length>0);
  for(const up of ups) assert.ok(up.every((value,axis)=>Math.abs(value-[0,1,0][axis])<1e-6), `Marker world up: ${up}`);
}
try {
  for (const suffix of ['?webgl','']) {
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    page.on('pageerror',error=>report.errors.push(error.message));
    await page.goto(base+suffix);
    assert.equal(await page.locator('#route-mode').isDisabled(),true);
    assert.equal(await page.locator('#reference-mode').isDisabled(),true);
    assert.equal(await page.locator('#new-marker-type').count(),0);
    await page.locator('#scene-file').setInputFiles(payload); await ready(page);
    const renderer=(await snapshot(page)).renderer;
    // Editing a newly added pin must not leave the active addition tool.
    for (const [index,type] of ['route','reference','reference'].entries()) {
      await page.locator(type==='route'?'#route-mode':'#reference-mode').click();
      const point = await project(page,[0,0,0]);
      await page.mouse.click(point.x,point.y);await count(page,index+1);
      assert.equal((await snapshot(page)).state.selectedMarkerId,index+1);
      assert.equal((await snapshot(page)).state.interactionMode,'add-marker');
      assert.equal(await page.locator('canvas').evaluate(canvas=>canvas.style.cursor),'crosshair');
      assert.equal(await page.locator(type==='route'?'#route-mode':'#reference-mode').getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('#marker-editor').isVisible(),true);
      assert.equal(await page.locator('#marker-editor-title').textContent(),`#${index+1}`);
      assert.equal(await page.locator('#marker-note').inputValue(),'');
      if(index===0) {
        await assertEditorLayout(page);
        const pose=(await snapshot(page)).pose;
        await page.getByRole('button',{name:'Blue',exact:true}).click();
        await page.locator('#marker-type-reference').click();
        await page.locator('#marker-name').fill('Saved name');
        await page.locator('#marker-note').fill('Saved note');
        await page.locator('#marker-name').press('Enter');
        assert.equal(await page.locator('#marker-save-status').textContent(),'Saved');
        assert.equal(await page.locator('#marker-name').evaluate(input=>input===document.activeElement),true);
        const marker=(await snapshot(page)).markers[0];
        assert.equal(marker.color,'blue');assert.equal(marker.type,'reference');
        assert.equal(marker.name,'Saved name');assert.equal(marker.note,'Saved note');
        await page.locator('#marker-name').fill('Keyboard draft');
        await page.locator('#marker-note').fill('Keyboard note draft');
        await page.locator('#marker-name').dispatchEvent('keydown',{key:'Enter',isComposing:true});
        assert.equal((await snapshot(page)).markers[0].name,'Saved name');
        await page.locator('#marker-note').press('End');await page.locator('#marker-note').press('Enter');
        assert.equal(await page.locator('#marker-note').inputValue(),'Keyboard note draft\n');
        assert.equal((await snapshot(page)).markers[0].note,'Saved note');
        await page.locator('#marker-name').focus();await page.keyboard.press('Tab');
        assert.equal(await page.locator('#marker-type-route').evaluate(button=>button===document.activeElement),true);
        await page.keyboard.press('Space');
        assert.equal((await snapshot(page)).markers[0].type,'route');
        await page.keyboard.press('Tab');await page.keyboard.press('Enter');
        assert.equal((await snapshot(page)).markers[0].type,'reference');
        assert.equal(await page.locator('#marker-name').inputValue(),'Keyboard draft');
        assert.equal(await page.locator('#marker-note').inputValue(),'Keyboard note draft\n');
        assert.equal((await snapshot(page)).markers[0].name,'Saved name');
        await assertEditorLayout(page);
        await page.screenshot({path:`${output}/${renderer}-editor.png`});
        assert.deepEqual((await snapshot(page)).pose,pose);
        await count(page,1);
      }
      await page.locator('#marker-note').fill('Draft to discard');
    }
    await page.locator('#delete-marker').click();await count(page,2);
    assert.equal(await page.locator('#marker-editor').isVisible(),false);
    assert.equal((await snapshot(page)).state.interactionMode,'add-marker');
    const next=await project(page,[0,0,0]);await page.mouse.click(next.x,next.y);await count(page,3);
    await page.locator('#marker-name').fill('Keep name');await page.locator('#marker-note').fill('Keep note');
    await page.locator('#marker-note').press('Escape');
    assert.equal((await snapshot(page)).state.interactionMode,'edit-markers');
    assert.equal((await snapshot(page)).state.selectedMarkerId,4);
    assert.equal(await page.locator('#marker-name').inputValue(),'Keep name');
    assert.equal(await page.locator('#marker-note').inputValue(),'Keep note');
    assert.equal(await page.locator('#marker-editor').isVisible(),true);
    await page.locator('#route-mode').click();assert.equal(await page.locator('#marker-editor').isVisible(),false);
    report.checks.push(`${renderer}: new route/reference auto-selection opens editor in Add; next point discards drafts; color/type autosave, Save and deletion work in Add; Escape retains selection and drafts`);
    await page.locator('#scene-file').setInputFiles(payload);await ready(page);await count(page,0);
    const angles = () => page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');
      const f=c.viewer.app.root.findComponents('camera')[0].entity.forward;
      return [Math.atan2(-f.x,-f.z),Math.asin(Math.max(-1,Math.min(1,f.y)))];
    });
    for (const cameraMode of ['orbit','fly']) for (const mode of ['edit-markers','add-marker']) {
      await page.locator(mode==='edit-markers'?'#edit-mode':'#route-mode').click();
      for (const [dx,dy,axis] of [[40,0,0],[0,40,1]]) {
        await page.locator('#fit-scene').click();await page.waitForTimeout(1000);
        await page.keyboard.press(cameraMode==='fly'?'2':'1');await page.waitForTimeout(400);
        assert.equal(await page.evaluate(async()=> (await import('/app.js')).controller.viewer.state.cameraMode),cameraMode);
        const before=await angles();
        await page.mouse.move(700,450);await page.mouse.down();
        await page.mouse.move(700+dx,450+dy,{steps:5});
        assert.equal(await page.locator('canvas').evaluate(canvas=>getComputedStyle(canvas).cursor),'none');
        await page.mouse.up();
        assert.equal(await page.evaluate(()=>document.documentElement.hasAttribute('data-camera-dragging')),false);
        await page.waitForTimeout(500);
        const after=await angles();
        const delta=Math.atan2(Math.sin(after[axis]-before[axis]),Math.cos(after[axis]-before[axis]));
        const expectedSign=cameraMode==='orbit'?-1:1;
        assert.ok(delta*expectedSign>.01,`${renderer}/${mode}/${cameraMode}: rotation axis ${axis}, expected sign ${expectedSign}, delta ${delta}`);
      }
      await page.locator('#fit-scene').click();await page.waitForTimeout(1000);
      await page.keyboard.press(cameraMode==='fly'?'2':'1');await page.waitForTimeout(400);
      const panBefore=await snapshot(page);
      await page.mouse.move(700,450);await page.mouse.down({button:'right'});
      await page.mouse.move(745,470,{steps:5});
      assert.equal(await page.locator('canvas').evaluate(canvas=>getComputedStyle(canvas).cursor),'none');
      await page.mouse.up({button:'right'});
      assert.equal(await page.evaluate(()=>document.documentElement.hasAttribute('data-camera-dragging')),false);
      await page.waitForTimeout(500);
      const panAfter=await snapshot(page);
      assert.notDeepEqual(panAfter.pose.slice(0,3),panBefore.pose.slice(0,3));
      assert.ok(panAfter.pose.slice(3).every((value,i)=>Math.abs(value-panBefore.pose[i+3])<1e-5),`${renderer}: RMB preserves camera orientation`);
      assert.equal(panAfter.markers.length,0);
    }
    await page.locator('#edit-mode').click();
    await page.keyboard.press('1');
    await page.locator('#fit-scene').click();await page.waitForTimeout(1000);
    report.checks.push(`${renderer}: LMB Orbit reverses its previous horizontal/vertical rotation; Fly retains its inverted axes in Edit/Add; RMB pan preserves orientation; camera drags create no markers`);
    // Observe existing upstream focus events, without changing their handlers.
    await page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');
      window.focusPicks=0;c.viewer.events.on('pick',()=>window.focusPicks++);
    });
    const point=await project(page,[1,1,-.3]);
    await page.mouse.click(point.x,point.y);
    await page.waitForFunction(()=>window.focusPicks===0);
    await page.waitForTimeout(800);
    assert.equal((await snapshot(page)).markers.length,0);
    await page.locator('#fit-scene').click(); await page.waitForTimeout(1000);
    await page.locator('#route-mode').click();
    assert.equal(await page.locator('canvas').evaluate(canvas=>canvas.style.cursor),'crosshair');
    const pose=(await snapshot(page)).pose;
    const placed=await project(page,[0,0,0]);
    await page.waitForTimeout(400); // Let the on-demand renderer become idle.
    await page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');
      window.markerWasRendered=false;
      c.addEventListener('markeradded',()=>{
        c.viewer.app.once('frameend',()=>{window.markerWasRendered=true;});
      },{once:true});
    });
    await page.mouse.click(placed.x,placed.y); await count(page,1);
    await page.waitForFunction(()=>window.markerWasRendered);
    assert.ok(await redPixels(page)>0,'A marker is visible before any subsequent camera movement');
    await assertUpright(page);
    assert.deepEqual((await snapshot(page)).pose,pose);
    assert.equal(await page.evaluate(()=>window.focusPicks),0);
    // Repeated clicks on the marker must still hit the splat surface below it.
    await page.mouse.dblclick(placed.x,placed.y); await count(page,3);
    const added=(await snapshot(page)).markers;
    assert.ok(added.every(marker=>Math.abs(marker.height-added[0].height)<1e-10));
    // Stochastic splat depth can vary across rendered frames within the fixture's
    // Gaussian footprint (sigma = exp(-2.5)); this is not a mesh surface.
    assert.ok(added.every(marker=>Math.hypot(...marker.anchor.position.map((value,axis)=>value-added[0].anchor.position[axis]))<3*Math.exp(-2.5)),JSON.stringify(added.map(marker=>marker.anchor.position)));
    await page.mouse.click(20,300); await page.waitForTimeout(300); await count(page,3);
    await page.mouse.move(placed.x,placed.y); await page.mouse.down();
    await page.mouse.move(placed.x+100,placed.y+70,{steps:10}); await page.mouse.up();
    await page.waitForTimeout(300); await count(page,3);
    await page.locator('#edit-mode').click(); await count(page,3);
    await page.locator('#fit-scene').click(); await page.waitForTimeout(1000);
    assert.equal((await snapshot(page)).state.interactionMode,'edit-markers');
    const anchors=(await snapshot(page)).markers;
    for(let index=0;index<3;index++) {
      await page.locator('#auto-level').uncheck();await assertUpright(page);
      await page.locator('#auto-level').check();await assertUpright(page);
      await page.locator('#display-rotation').uncheck();await assertUpright(page);
      await page.locator('#display-rotation').check();await assertUpright(page);
    }
    assert.deepEqual((await snapshot(page)).markers,anchors);
    const geometry=await page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');
      const marker=c.viewer.app.root.findByName('VoluScapeMarker');
      const component=c.viewer.app.root.findComponents('gsplat')[0];
      const actual=marker.getPosition(),expected=component.entity.getWorldTransform().transformPoint(marker.getLocalPosition());
      const renders=marker.findComponents('render');
      return {position:[actual.x,actual.y,actual.z],expected:[expected.x,expected.y,expected.z],
        shapes:renders.map(render=>render.type),
        pickable:renders.some(render=>render.meshInstances.some(mesh=>mesh.pick)),
        depth:renders.every(render=>render.meshInstances.every(mesh=>mesh.material.depthTest&&mesh.material.depthWrite))};
    });
    assert.ok(geometry.position.every((value,axis)=>Math.abs(value-geometry.expected[axis])<1e-6));
    assert.deepEqual(geometry.shapes,['cone','sphere']);assert.equal(geometry.pickable,false);assert.equal(geometry.depth,true);
    await page.screenshot({path:`${output}/${renderer}-markers.png`});
    // Isolate apparent marker size from stochastic splat-depth occlusion.
    // Depth occlusion is verified independently immediately below.
    await page.evaluate(async () => {
      const { controller: c } = await import('/app.js');
      for (const component of c.viewer.app.root.findComponents('gsplat')) component.enabled = false;
      await new Promise(resolve => { c.viewer.app.once('frameend', resolve); c.viewer.app.renderNextFrame = true; });
    });
    const farPixels=await redPixels(page);
    assert.ok(farPixels>0,'Red 3D marker geometry is actually rendered');
    const near=await project(page,[0,0,0]);
    await page.mouse.move(near.x,near.y);await page.mouse.wheel(0,-200);await page.waitForTimeout(1000);
    const nearPixels=await redPixels(page);
    assert.ok(nearPixels>farPixels,`World-space markers grow with zoom: ${farPixels} -> ${nearPixels}`);
    await page.screenshot({path:`${output}/${renderer}-marker-closeup.png`});
    await page.evaluate(async () => {
      const { controller: c } = await import('/app.js');
      for (const component of c.viewer.app.root.findComponents('gsplat')) component.enabled = true;
      await new Promise(resolve => { c.viewer.app.once('frameend', resolve); c.viewer.app.renderNextFrame = true; });
    });
    // Verify actual depth occlusion independently of pin orientation: put a temporary
    // upright visual entirely below the ground and hide the visible session pins.
    await page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');
      for(const {visual} of c.session.markers.items) visual.entity.enabled=false;
      for(const connection of c.session.markers.connections) connection.entity.enabled=false;
      const height=c.markers[0].height;
      window.occlusionVisual=c.viewer.createMarkerVisual({position:[0,-2*height,0],normal:[1,0,0],height});
    });
    await page.waitForTimeout(300);
    const hiddenPixels=await redPixels(page);
    assert.equal(hiddenPixels,0,'The splat surface occludes an upright pin placed entirely below it');
    await page.screenshot({path:`${output}/${renderer}-marker-occluded.png`});
    await page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');
      window.occlusionVisual.destroy();delete window.occlusionVisual;
      for(const {visual} of c.session.markers.items)visual.entity.enabled=true;
      for(const connection of c.session.markers.connections)connection.update();
      c.viewer.app.renderNextFrame=true;
    });
    await page.waitForTimeout(300);
    report.checks.push(`${renderer}: visible marker pixels ${farPixels}, zoomed ${nearPixels}, occluded ${hiddenPixels}`);
    // Deliberately supply a wall/downward/zero normal while retaining actual scene positions.
    await page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');
      const original=c.viewer.pickSurface;
      for(const normal of [[1,0,0],[0,-1,0],[0,0,0]]) {
        c.viewer.pickSurface=async()=>({position:[0,0,0],normal});
        c.setInteractionMode('add-marker');await c.session.markers.addAt(.5,.5);
      }
      c.viewer.pickSurface=original;c.setInteractionMode('edit-markers');
    });
    await assertUpright(page);
    report.checks.push(`${renderer}: idle-camera marker rendered immediately; all pins stay world +Y with Auto level/rotation on or off and wall/downward/zero pick normals`);
    await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
    await page.locator('#fit-scene').click();await page.waitForTimeout(1000);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual((await snapshot(page)).markers.slice(0,anchors.length),anchors);
    await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(200);
    await page.locator('#fit-scene').click();await page.waitForTimeout(1000);
    await page.locator('#route-mode').click();
    const chainPose=(await snapshot(page)).pose;
    for(const point of [[1,0,-.2],[0,1,-.1]]) {
      const screen=await project(page,point);
      await page.mouse.click(screen.x,screen.y);
    }
    await count(page,8);await page.waitForTimeout(200);
    assert.deepEqual((await snapshot(page)).pose,chainPose);
    async function assertChain() {
      const result=await page.evaluate(async()=>{
        const {controller:c}=await import('/app.js');
        const {items,connections}=c.session.markers;
        const errors=connections.map((connection,index)=>{
          if(!connection.entity.enabled)return 0;
          const entity=connection.entity;
          const point=entity.getPosition().clone().set(0,-.5,0);
          const a=entity.getWorldTransform().transformPoint(point);
          const b=entity.getWorldTransform().transformPoint(point.clone().set(0,.5,0));
          const first=items[index].visual.entity.findByName('Marker-sphere').getPosition();
          const second=items[index+1].visual.entity.findByName('Marker-sphere').getPosition();
          return Math.max(a.distance(first),b.distance(second));
        });
        return {count:connections.length,expected:items.length-1,error:Math.max(...errors),
          geometry:connections.every(connection=>connection.entity.render.type==='cylinder'&&connection.entity.render.meshInstances.every(mesh=>!mesh.pick&&mesh.material.depthTest)),
          color:connections.every((connection,index)=>{
            const material=connection.entity.render.meshInstances[0].material;
            const pinMaterial=items[index].visual.entity.findByName('Marker-sphere').render.meshInstances[0].material;
            return material!==pinMaterial && Math.abs(material.emissive.r-1)<1e-6 && material.emissive.g<.04;
          })};
      });
      assert.equal(result.count,result.expected);assert.ok(result.error<1e-5,`Chain endpoint error: ${result.error}`);
      assert.equal(result.geometry,true);assert.equal(result.color,true);
    }
    await assertChain();
    await page.screenshot({path:`${output}/${renderer}-connected-markers.png`});
    assert.ok(await redPixels(page)>50,'Straight red connections are visibly rendered without camera movement');
    await page.locator('#auto-level').uncheck();await assertChain();
    await page.locator('#display-rotation').uncheck();await assertChain();
    await page.locator('#display-rotation').check();await page.locator('#auto-level').check();await assertChain();
    report.checks.push(`${renderer}: consecutive red head-to-head segments visible on idle camera; ordered open chain, transform alignment and non-pickable depth-tested geometry`);
    await page.waitForTimeout(1000);
    await page.locator('#edit-mode').click();
    await page.evaluate(async () => (await import('/app.js')).controller.clearMarkerSelection());
    const insertion = await page.evaluate(async () => {
      const { controller: c } = await import('/app.js');
      const { hitMarkerSegment } = await import('/markers.js');
      const markers = c.session.markers;
      const rect = document.querySelector('canvas').getBoundingClientRect();
      for (const connection of markers.connections) {
        const segment = connection.screenSegment();
        if (!segment) continue;
        for (const s of [.5, .3, .7]) {
          const x = Math.round(segment.a.x + s * (segment.b.x - segment.a.x));
          const y = Math.round(segment.a.y + s * (segment.b.y - segment.a.y));
          if (x < 210 || x > 1150 || y < 180 || y > 750) continue;
          if (markers.items.some(({ visual }) => {
            const p = visual.screenPosition(); return p && Math.hypot(p.x - x, p.y - y) < 25;
          })) continue;
          const hits = markers.connections.map(line => ({ line, hit: hitMarkerSegment(line.screenSegment(), x, y) }))
            .filter(candidate => candidate.hit).sort((a,b) => a.hit.distance-b.hit.distance || a.hit.depth-b.hit.depth);
          const chosen = hits[0];
          return { x: x + rect.left, y: y + rect.top, position: chosen.hit.position,
            from: chosen.line.fromMarker.record.id, to: chosen.line.toMarker.record.id, id: markers.nextId };
        }
      }
      throw new Error('No unobstructed synthetic segment for insertion');
    });
    const insertionBefore = await snapshot(page);
    const segmentGuards = await page.evaluate(async ({ from, to }) => {
      const { controller:c } = await import('/app.js');
      const markers = c.session.markers;
      const connection = markers.connections.find(line => line.fromMarker.record.id === from && line.toMarker.record.id === to);
      const camera = c.viewer.app.root.findComponents('camera')[0];
      const segment = connection.screenSegment(), near = camera.nearClip;
      let clipped;
      try {
        camera.nearClip = (segment.a.depth + segment.b.depth) / 2;
        clipped = connection.screenSegment() === null;
      } finally { camera.nearClip = near; }
      const zero = markers.connect(connection.fromMarker, connection.fromMarker);
      const degenerate = zero.screenSegment() === null; zero.destroy();
      window.insertionSurfacePicker = c.viewer.pickSurface;
      c.viewer.pickSurface = () => { throw new Error('Insertion must not pick a surface'); };
      return { clipped, degenerate };
    }, insertion);
    assert.deepEqual(segmentGuards, { clipped:true, degenerate:true });
    await page.mouse.dblclick(insertion.x, insertion.y); await count(page, 9);
    await page.evaluate(async () => {
      const { controller:c } = await import('/app.js');
      c.viewer.pickSurface = window.insertionSurfacePicker; delete window.insertionSurfacePicker;
    });
    const inserted = await snapshot(page);
    assert.deepEqual(inserted.pose, insertionBefore.pose);
    assert.equal(inserted.state.interactionMode, 'edit-markers');
    assert.equal(inserted.state.selectedMarkerId, insertion.id);
    assert.equal(await page.locator('#marker-editor').isVisible(), true);
    const insertedIndex = inserted.markers.findIndex(marker => marker.id === insertion.id);
    assert.equal(inserted.markers[insertedIndex-1].id, insertion.from);
    assert.equal(inserted.markers[insertedIndex+1].id, insertion.to);
    const headError = await page.evaluate(async ({ id, position }) => {
      const { controller:c } = await import('/app.js');
      const head = c.session.markers.items.find(item => item.record.id === id).visual.entity.findByName('Marker-sphere').getPosition();
      return Math.hypot(head.x-position[0], head.y-position[1], head.z-position[2]);
    }, insertion);
    assert.ok(headError < 1e-5, `Inserted head error ${headError}`);
    await assertChain(); await assertUpright(page);
    await page.screenshot({ path: `${output}/${renderer}-inserted-route-point.png` });
    for (const toggle of ['#auto-level', '#display-rotation', '#display-rotation', '#auto-level']) {
      await page.locator(toggle).click(); await assertChain(); await assertUpright(page);
      const alignment = await page.evaluate(async ({ from, to, id }) => {
        const { controller:c } = await import('/app.js');
        const items = c.session.markers.items;
        const head = id => items.find(item => item.record.id === id).visual.entity.findByName('Marker-sphere').getPosition().clone();
        const a = head(from), direction = head(to).sub(a), offset = head(id).sub(a);
        const error = offset.clone().cross(offset, direction).length() / direction.length();
        return { error, anchor:c.markers.find(marker => marker.id === id).anchor };
      }, insertion);
      assert.ok(alignment.error < 1e-5, `Inserted head stays collinear after orientation: ${alignment.error}`);
      assert.deepEqual(alignment.anchor, inserted.markers[insertedIndex].anchor);
    }
    const insertedHead = await page.evaluate(async id => {
      const { controller:c } = await import('/app.js');
      const p = c.session.markers.items.find(item => item.record.id === id).visual.screenPosition();
      const rect = document.querySelector('canvas').getBoundingClientRect();
      return { x:p.x+rect.left, y:p.y+rect.top };
    }, insertion.id);
    await page.mouse.dblclick(insertedHead.x, insertedHead.y); await count(page, 9);
    await page.mouse.dblclick(15, 300); await count(page, 9);
    await page.evaluate(async id => (await import('/app.js')).controller.session.markers.select(id), insertion.id);
    await page.locator('#delete-marker').click(); await count(page, 8); await assertChain();
    report.checks.push(`${renderer}: real double click inserts exactly one selected route point on the perspective-correct segment without surface picking, opens editor without camera movement; near-plane/degenerate/head/background exclusion, orientation collinearity and source-anchor preservation; deletion restores chain`);
    const beforeEdit=await snapshot(page);
    const head=await page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');
      const p=c.session.markers.items[6].visual.screenPosition();
      const rect=document.querySelector('canvas').getBoundingClientRect();
      return {x:p.x+rect.left,y:p.y+rect.top};
    });
    const destination=await project(page,[-1,1,.1]);
    await page.mouse.move(head.x,head.y);await page.mouse.down();
    await page.mouse.move(destination.x,destination.y,{steps:8});await page.mouse.up();
    await page.waitForFunction(async()=>{
      const {controller:c}=await import('/app.js');
      return c.markers[6].anchor.position[0]<-.5;
    });
    assert.deepEqual((await snapshot(page)).pose,beforeEdit.pose,'Dragging a pin does not navigate');
    assert.equal((await snapshot(page)).markers.length,8);
    assert.equal((await snapshot(page)).state.selectedMarkerId,7);
    await assertChain();await assertUpright(page);
    await page.screenshot({path:`${output}/${renderer}-edited-markers.png`});
    await page.locator('#delete-marker').click();await count(page,7);
    assert.deepEqual((await snapshot(page)).markers.map(marker=>marker.id),[1,2,3,4,5,6,8]);
    await assertChain();
    assert.equal(await page.locator('#delete-marker').isDisabled(),true);
    const lastHead=await page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');const p=c.session.markers.items.at(-1).visual.screenPosition();
      const rect=document.querySelector('canvas').getBoundingClientRect();return {x:p.x+rect.left,y:p.y+rect.top};
    });
    await page.mouse.click(lastHead.x,lastHead.y);await page.keyboard.press('Delete');await count(page,6);
    await assertChain();
    await page.locator('#display-rotation').uncheck();await page.locator('#display-rotation').check();
    await assertChain();await assertUpright(page);
    report.checks.push(`${renderer}: real pointer drag changes source anchor without moving camera; button middle deletion reconnects neighbors; keyboard deletion, selection reset, orientation alignment`);
    await page.locator('#scene-file').setInputFiles(payload);await ready(page);await count(page,0);
    assert.equal(await page.evaluate(async()=>!(await import('/app.js')).controller.viewer.app.root.findByName('VoluScapeMarkerConnection')),true);
    assert.equal((await snapshot(page)).entities,false);
    assert.equal((await snapshot(page)).state.interactionMode,'edit-markers');
    await page.locator('#route-mode').click();
    assert.equal(await page.locator('canvas').evaluate(canvas=>canvas.style.cursor),'crosshair');
    for(const position of [[1,0,-.2],[-1,0,.2],[0,1,-.1]]) {
      const p=await project(page,position);await page.mouse.click(p.x,p.y);
    }
    await count(page,3);
    assert.equal(await page.locator('.marker-label').count(),0);
    await page.locator('#reference-mode').click();await page.locator('#reference-mode').focus();await page.keyboard.press('Escape');
    assert.equal((await snapshot(page)).state.interactionMode,'edit-markers');
    assert.equal(await page.locator('canvas').evaluate(canvas=>canvas.style.cursor),'pointer');
    async function selectMarker(index) {
      const head=await page.evaluate(async index=>{
        const {controller:c}=await import('/app.js');const p=c.session.markers.items[index].visual.screenPosition();
        const rect=document.querySelector('canvas').getBoundingClientRect();return {x:p.x+rect.left,y:p.y+rect.top};
      },index);
      await page.mouse.click(head.x,head.y);
      await page.waitForFunction(index=>document.getElementById('marker-editor-title').textContent===`#${index+1}`,index);
      return head;
    }
    await selectMarker(0);
    assert.equal(await page.locator('#marker-name').inputValue(),'');
    await page.locator('#marker-name').fill('Trail junction');
    await page.locator('#marker-note').fill('Keep this draft');
    const escapeState=await snapshot(page);
    for(const id of ['marker-name','marker-note','marker-type-route','marker-type-reference']) {
      await page.locator(`#${id}`).focus();await page.keyboard.press('Escape');
      assert.deepEqual((await snapshot(page)).pose,escapeState.pose);
      assert.equal((await snapshot(page)).state.selectedMarkerId,escapeState.state.selectedMarkerId);
      assert.equal(await page.locator('#marker-name').inputValue(),'Trail junction');
      assert.equal(await page.locator('#marker-note').inputValue(),'Keep this draft');
      assert.equal(await page.locator('#marker-editor').isVisible(),false);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#marker-editor').isVisible(),false);
      await selectMarker(0);
      assert.equal(await page.locator('#marker-editor').isVisible(),true);
    }
    assert.equal(await page.locator('.marker-label').count(),0);
    assert.equal(await page.locator('#marker-palette button').count(),6);
    assert.deepEqual(await page.locator('#marker-palette button').evaluateAll(buttons=>buttons.map(button=>button.dataset.color)),['red','blue','yellow','green','magenta','white']);
    const metadataPose=(await snapshot(page)).pose;
    await page.getByRole('button',{name:'Blue',exact:true}).click();
    const note='First line\nSecond line <b>plain text</b>';
    await page.locator('#marker-note').fill(note);
    await page.locator('#marker-note').press('End');await page.locator('#marker-note').pressSequentially('wasdfhx');
    for(let i=0;i<7;i++)await page.locator('#marker-note').press('Backspace');
    await page.locator('#marker-note').press('Delete');await page.waitForTimeout(200);
    assert.deepEqual((await snapshot(page)).pose,metadataPose);
    assert.equal((await snapshot(page)).markers.length,3);
    assert.equal((await snapshot(page)).markers[0].color,'blue');
    assert.equal((await snapshot(page)).markers[0].note,'');
    await page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');window.metadataRendered=false;
      c.addEventListener('markerchange',()=>c.viewer.app.once('frameend',()=>{window.metadataRendered=true;}),{once:true});
    });
    await page.locator('#save-marker').click();
    await page.waitForFunction(()=>window.metadataRendered);
    assert.deepEqual((await snapshot(page)).pose,metadataPose,'Saving metadata requests a frame without moving the camera');
    assert.equal((await snapshot(page)).markers[0].note,note);
    const routeLabel=page.locator('.marker-label[data-marker-id="1"]');
    await routeLabel.waitFor({state:'visible'});assert.equal(await routeLabel.textContent(),'Trail junction');
    assert.equal((await snapshot(page)).markers[0].color,'blue');
    const materialColors=()=>page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');const m=c.session.markers;
      const rgb=entity=>{const e=entity.render.meshInstances[0].material.emissive;return [e.r,e.g,e.b];};
      return {pins:m.items.map(({visual})=>rgb(visual.entity.findByName('Marker-sphere'))),
        cones:m.items.map(({visual})=>rgb(visual.entity.findByName('Marker-cone'))),
        links:m.connections.map(connection=>rgb(connection.entity))};
    });
    const red=[1,8/255,5/255], blue=[32/255,128/255,1];
    assert.deepEqual((await materialColors()).links,[red,red]);
    await page.getByRole('button',{name:'Yellow',exact:true}).click();
    assert.equal((await snapshot(page)).markers[0].note,note);
    await page.getByRole('button',{name:'Blue',exact:true}).click();await page.locator('#marker-note').fill('Discard me');
    await selectMarker(1);await selectMarker(0);
    assert.equal(await page.locator('#marker-note').inputValue(),note);
    assert.equal(await page.getByRole('button',{name:'Blue',exact:true}).getAttribute('aria-pressed'),'true');
    await page.locator('#marker-note').fill('Discard on mode change');
    await page.locator('#route-mode').click();assert.equal(await page.locator('#marker-editor').isVisible(),false);
    await page.locator('#edit-mode').click();await selectMarker(0);
    assert.equal(await page.locator('#marker-note').inputValue(),note);
    await page.locator('#marker-note').fill('Draft retained while dragging');
    const moveHead=await selectMarker(0), target=await project(page,[1,-1,-.1]);
    await page.mouse.move(moveHead.x,moveHead.y);await page.mouse.down();await page.mouse.move(target.x,target.y,{steps:5});await page.mouse.up();
    await page.waitForFunction(async()=> (await import('/app.js')).controller.markers[0].anchor.position[1]<-.5);
    assert.equal(await page.locator('#marker-note').inputValue(),'Draft retained while dragging');
    await page.locator('#auto-level').uncheck();await page.locator('#auto-level').check();
    assert.equal(await page.locator('#marker-note').inputValue(),'Draft retained while dragging');
    assert.equal((await snapshot(page)).markers[0].note,note);
    await page.waitForTimeout(1000);await selectMarker(2);
    await page.getByRole('button',{name:'Blue',exact:true}).click();await page.locator('#save-marker').click();
    await selectMarker(1);
    await page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');window.disposedSegmentMaterials=0;
      for(const connection of c.session.markers.connections){
        const material=connection.entity.render.meshInstances[0].material, original=material.destroy.bind(material);
        material.destroy=()=>{window.disposedSegmentMaterials++;original();};
      }
    });
    await page.locator('#delete-marker').click();await count(page,2);
    assert.equal(await page.evaluate(()=>window.disposedSegmentMaterials),2);
    assert.deepEqual((await materialColors()).links,[blue]);
    assert.deepEqual((await materialColors()).pins,[blue,blue]);
    assert.deepEqual((await materialColors()).cones,[blue,blue]);
    await page.locator('#fit-scene').click();await page.waitForTimeout(1000);
    await page.screenshot({path:`${output}/${renderer}-metadata.png`});
    const {data:colored,info:dimensions}=await sharp(await page.screenshot()).removeAlpha().raw().toBuffer({resolveWithObject:true});
    let bluePixels=0;
    for(let y=200;y<dimensions.height-160;y++)for(let x=200;x<dimensions.width-350;x++){
      const i=(y*dimensions.width+x)*dimensions.channels;
      if(colored[i]<100&&colored[i+1]<180&&colored[i+2]>170)bluePixels++;
    }
    assert.ok(bluePixels>10,'Blue pins and segment visibly rendered');
    assert.equal((await snapshot(page)).markers[0].note,note);
    await page.locator('#edit-mode').click();await selectMarker(0);
    await page.locator('#marker-name').fill('Renamed route');await page.locator('#marker-name').press('Enter');
    await routeLabel.waitFor({state:'visible'});assert.equal(await routeLabel.textContent(),'Renamed route');
    await page.screenshot({path:`${output}/${renderer}-route-label.png`});
    await page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');window.releaseClearedLabel=null;
      window.originalVisibility=c.viewer.pickVisibility;
      c.viewer.pickVisibility=()=>new Promise(resolve=>{window.releaseClearedLabel=resolve;});
      c.session.labels.invalidate();c.session.labels.refresh();
    });
    await page.waitForFunction(()=>window.releaseClearedLabel!==null);
    await page.locator('#marker-name').fill('   ');await page.locator('#marker-name').press('Enter');
    await page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');window.releaseClearedLabel([0]);c.viewer.pickVisibility=window.originalVisibility;
    });
    assert.equal(await routeLabel.count(),0);assert.equal((await snapshot(page)).markers[0].name,'');
    report.checks.push(`${renderer}: Escape from Reference button and repeated Escape in editor fields keeps selection/drafts/pose; route names blank initially, appear only after Save, rename/clear and stale-clear visibility cleanup`);
    report.checks.push(`${renderer}: pointer/crosshair modes; color autosave and text Save, multiline plain text without camera input; discarded and retained drafts; red mixed-color fallback, blue reconnection, segment material disposal and visible blue pixels ${bluePixels}`);
    await page.locator('#scene-file').setInputFiles(payload);await ready(page);await count(page,0);
    assert.equal(await page.locator('#marker-editor').isVisible(),false);
    await page.locator('#route-mode').click();
    let referenceCount=0;
    for(const [type,position] of [['route',[1,0,-.2]],['reference',[0,0,0]],['route',[-1,0,.2]]]) {
      await page.locator(type==='route'?'#route-mode':'#reference-mode').click();
      assert.equal(await page.locator(type==='route'?'#route-mode':'#reference-mode').getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator(type==='route'?'#reference-mode':'#route-mode').getAttribute('aria-pressed'),'false');
      assert.equal(await page.locator('#edit-mode').getAttribute('aria-pressed'),'false');
      const p=await project(page,position);await page.mouse.click(p.x,p.y);
      await count(page,++referenceCount);
      assert.equal((await snapshot(page)).markers.at(-1).type,type);
      assert.equal((await snapshot(page)).state.interactionMode,'add-marker');
    }
    await count(page,3);
    const referenceLabel=page.locator('.marker-label[data-marker-id="2"]');
    await referenceLabel.waitFor({state:'visible'});
    assert.equal(await referenceLabel.textContent(),'Reference 2');
    assert.equal(await page.evaluate(async()=> (await import('/app.js')).controller.session.markers.connections.length),1);
    await page.locator('#edit-mode').click();await selectMarker(1);
    await page.locator('#marker-name').fill('Spring <b>plain</b>');
    await page.locator('#marker-note').fill('Unsaved reference comment');
    await page.getByRole('button',{name:'Magenta',exact:true}).click();
    assert.equal((await snapshot(page)).markers[1].color,'magenta');
    assert.equal((await snapshot(page)).markers[1].note,'');
    assert.equal(await page.locator('#marker-name').inputValue(),'Spring <b>plain</b>');
    await page.locator('#marker-type-route').click();
    await referenceLabel.waitFor({state:'visible'});assert.equal(await referenceLabel.textContent(),'Reference 2');
    assert.equal(await page.evaluate(async()=> (await import('/app.js')).controller.session.markers.connections.length),2);
    await page.locator('#marker-type-reference').click();
    assert.equal(await page.locator('#marker-note').inputValue(),'Unsaved reference comment');
    assert.equal(await page.locator('#marker-name').inputValue(),'Spring <b>plain</b>');
    await page.locator('#marker-name').press('Enter');await referenceLabel.waitFor({state:'visible'});
    assert.equal(await referenceLabel.textContent(),'Spring <b>plain</b>');assert.equal(await referenceLabel.locator('b').count(),0);
    await page.locator('#fit-scene').click();await page.waitForTimeout(1000);
    await page.locator('#auto-level').uncheck();await page.locator('#auto-level').check();
    await referenceLabel.waitFor({state:'visible'});
    await page.screenshot({path:`${output}/${renderer}-reference.png`});
    const labelPose=(await snapshot(page)).pose;
    await page.locator('#marker-note').fill('Keep label draft');
    await referenceLabel.click();
    assert.equal((await snapshot(page)).state.selectedMarkerId,2);
    assert.equal(await page.locator('#marker-note').inputValue(),'Keep label draft');
    assert.equal(await referenceLabel.evaluate(label=>getComputedStyle(label).cursor),'pointer');
    for (const type of ['reference','route']) {
      await page.locator(`#marker-type-${type}`).click();
      await referenceLabel.waitFor({state:'visible'});
      const box=await referenceLabel.boundingBox();
      const before=(await snapshot(page)).markers[1].anchor.position;
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
      await page.mouse.move(box.x+box.width/2+45,box.y+box.height/2+12,{steps:5});
      assert.equal(await page.locator('canvas').evaluate(canvas=>getComputedStyle(canvas).cursor),'none');
      assert.equal(await referenceLabel.evaluate(label=>getComputedStyle(label).cursor),'none');
      await page.mouse.up();
      assert.equal(await page.locator('canvas').evaluate(canvas=>getComputedStyle(canvas).cursor),'pointer');
      assert.equal(await page.evaluate(()=>document.documentElement.hasAttribute('data-marker-dragging')),false);
      await page.waitForFunction(async before=>{
        const {controller:c}=await import('/app.js');
        return c.markers[1].anchor.position.some((value,i)=>Math.abs(value-before[i])>.01);
      },before);
      assert.deepEqual((await snapshot(page)).pose,labelPose);
      assert.equal(await page.locator('#marker-note').inputValue(),'Keep label draft');
    }
    await referenceLabel.waitFor({state:'visible'});
    await page.screenshot({path:`${output}/${renderer}-label-drag.png`});
    await page.locator('#route-mode').click();
    await page.waitForFunction(()=>document.querySelector('.marker-labels').dataset.mode==='add-marker');
    assert.equal(await referenceLabel.evaluate(label=>getComputedStyle(label).pointerEvents),'none');
    await page.locator('#edit-mode').click();await referenceLabel.click();
    assert.equal(await page.locator('#marker-note').inputValue(),'Unsaved reference comment');
    report.checks.push(`${renderer}: reference/route labels select and drag via canvas capture without camera movement; repeated selection and dragging preserve drafts; Add marker labels pass through input`);
    await page.locator('#marker-type-route').click();await referenceLabel.waitFor({state:'visible'});
    assert.equal(await page.locator('#marker-name').inputValue(),'Spring <b>plain</b>');
    // Occlusion uses actual splat visibility readback, not a hypothetical plane.
    await page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');const item=c.session.markers.items[1];
      const p=item.visual.entity.getPosition();window.referenceWorld=[p.x,p.y,p.z];
      const camera=c.viewer.app.root.findComponents('camera')[0].entity.getPosition();
      const behind=p.clone().sub(camera).mulScalar(1.5).add(camera);
      item.visual.moveTo({position:[behind.x,behind.y,behind.z]});
      c.session.labels.invalidate();c.session.labels.refresh();
    });
    await page.waitForTimeout(600);assert.equal(await referenceLabel.isVisible(),false);
    await page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');c.session.markers.items[1].visual.moveTo({position:[100000,0,0]});
      c.session.labels.refresh();
    });
    assert.equal(await referenceLabel.isVisible(),false);
    await page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');const camera=c.viewer.app.root.findComponents('camera')[0].entity;
      const p=camera.getPosition().clone().sub(camera.forward.clone().mulScalar(5));
      c.session.markers.items[1].visual.moveTo({position:[p.x,p.y,p.z]});c.session.labels.refresh();
    });
    assert.equal(await referenceLabel.isVisible(),false);
    await page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');c.session.markers.items[1].visual.moveTo({position:window.referenceWorld});
      c.session.labels.refresh();
    });
    await referenceLabel.waitFor({state:'visible'});
    await page.setViewportSize({width:1000,height:750});await referenceLabel.waitFor({state:'visible'});
    await page.evaluate(async()=>{
      const {controller:c}=await import('/app.js');window.releaseLabelPick=null;
      c.viewer.pickVisibility=()=>new Promise(resolve=>{window.releaseLabelPick=resolve;});
      c.session.labels.invalidate();c.session.labels.refresh();
    });
    await page.waitForFunction(()=>window.releaseLabelPick!==null);
    await page.locator('#scene-file').setInputFiles(payload);await ready(page);await count(page,0);
    await page.evaluate(()=>window.releaseLabelPick([0]));
    assert.equal(await page.locator('.marker-label').count(),0);
    assert.equal((await snapshot(page)).state.interactionMode,'edit-markers');
    assert.equal((await snapshot(page)).state.newMarkerType,'route');
    report.checks.push(`${renderer}: route-reference-route skips reference; type conversion rebuilds chain; name/comment Save preserves drafts across autosaved color/type; plain labels visible, splat-occluded/offscreen/behind-camera hidden; resize/orientation and stale-label replacement cleanup`);
    // Deterministic picks exercise host policy independently of surface visibility.
    for (const [width, height, compact] of [[768, 700, true], [769, 700, false], [900, 480, true], [900, 481, false]]) {
      await page.setViewportSize({ width, height });
      for (const type of ['route', 'reference']) {
        await page.evaluate(async type => {
          const { controller:c } = await import('/app.js');
          c.setNewMarkerType(type); c.setInteractionMode('add-marker');
          const pick = c.viewer.pickSurface;
          try {
            c.viewer.pickSurface = async () => ({ position:[0,0,0], normal:[0,1,0] });
            await c.session.markers.addAt(.5,.5);
          } finally { c.viewer.pickSurface = pick; }
        }, type);
        assert.equal(await page.locator('#marker-editor').isVisible(), !compact);
        assert.equal((await snapshot(page)).state.interactionMode, 'add-marker');
        const id = (await snapshot(page)).state.selectedMarkerId;
        assert.ok(id !== null);
        await page.setViewportSize({ width:1000, height:750 });
        assert.equal(await page.locator('#marker-editor').isVisible(), !compact, 'Resize does not open a suppressed editor');
        await page.evaluate(async id => {
          const { controller:c } = await import('/app.js');
          c.setInteractionMode('edit-markers');
        }, id);
        assert.equal(await page.locator('#marker-editor').isVisible(), !compact, 'Mode switch does not open editor');
        await page.evaluate(async id => (await import('/app.js')).controller.session.markers.select(id), id);
        assert.equal(await page.locator('#marker-editor').isVisible(), true);
        await page.locator('#marker-note').fill('Viewport draft');
        await page.setViewportSize({ width, height });
        assert.equal(await page.locator('#marker-editor').isVisible(), true);
        assert.equal(await page.locator('#marker-note').inputValue(), 'Viewport draft');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#marker-editor').isVisible(), false);
        assert.equal(await page.locator('#marker-note').inputValue(), 'Viewport draft');
      }
    }
    await page.locator('#scene-file').setInputFiles(payload); await ready(page); await count(page,0);
    assert.equal(await page.locator('#marker-editor').isVisible(), false);
    await page.setViewportSize({width:1000,height:480});
    await page.evaluate(async () => {
      const { controller:c } = await import('/app.js');
      c.setInteractionMode('add-marker');
      const pick = c.viewer.pickSurface;
      try {
        for (const x of [-.8, .8]) {
          c.viewer.pickSurface = async () => ({ position:[x,0,0], normal:[0,1,0] });
          await c.session.markers.addAt(.5,.5);
        }
      } finally { c.viewer.pickSurface = pick; }
      c.setInteractionMode('edit-markers');
      const segment = c.session.markers.connections[0].screenSegment();
      const rect = document.querySelector('canvas').getBoundingClientRect();
      c.session.markers.insertAt(rect.left + (segment.a.x+segment.b.x)/2, rect.top + (segment.a.y+segment.b.y)/2);
    });
    await count(page,3);
    assert.equal((await snapshot(page)).state.selectedMarkerId,3);
    assert.equal(await page.locator('#marker-editor').isVisible(),false);
    await page.locator('#scene-file').setInputFiles(payload); await ready(page); await count(page,0);
    await page.setViewportSize({width:1000,height:750});
    report.checks.push(`${renderer}: route/reference creation at width 768/769 and height 480/481 and compact segment insertion; selection retained; resize/mode switch do not open suppressed editor; repeated manual selection opens; resize and Escape preserve drafts; replacement clears editor`);
    await page.locator('#route-mode').click();
    // Stale picks cannot materialize after mode or orientation changes.
    for(const action of ['mode','orientation','close']) {
      await page.evaluate(async action=>{
        const {controller:c}=await import('/app.js');
        const real=c.viewer.pickSurface;
        let release;
        c.viewer.pickSurface=()=>new Promise(resolve=>{release=resolve;});
        const markers=c.session.markers;
        const pending=markers.addAt(.5,.5);
        if(action==='mode'){c.setInteractionMode('edit-markers');c.setInteractionMode('add-marker');}
        else if(action==='orientation')c.setDisplayRotation(!c.displayRotation);
        else c.closeScene();
        release({position:[0,0,0],normal:[0,1,0]});await pending;
        if(c.viewer)c.viewer.pickSurface=real;
      },action);
      await count(page,0);
    }
    assert.equal(await page.locator('canvas').count(),0);
    report.checks.push(`${renderer}: Edit markers has no click-to-focus; marker click/double-click/background/drag; source anchoring; depth-tested non-pickable primitives; viewport, replacement and stale-pick cleanup`);
    await page.close();
  }
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
  await page.goto(base+'?webgl');await page.locator('#scene-file').setInputFiles(payload);await ready(page);
  await page.locator('#route-mode').tap();
  await page.locator('.sse-controlsHintClose').click();
  const center=await project(page,[0,0,0]);
  const pose=(await snapshot(page)).pose;
  await page.touchscreen.tap(center.x,center.y);await count(page,1);
  assert.equal(await page.locator('#marker-editor').isVisible(),false);
  assert.equal((await snapshot(page)).state.selectedMarkerId,1);
  assert.equal((await snapshot(page)).state.interactionMode,'add-marker');
  assert.deepEqual((await snapshot(page)).pose,pose);
  // Close the overlay before the navigation gesture crosses its screen area.
  await page.locator('#edit-mode').tap();await page.locator('#route-mode').tap();
  const cdp=await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x:center.x-50,y:center.y},{id:2,x:center.x+50,y:center.y}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x:center.x-70,y:center.y+20},{id:2,x:center.x+70,y:center.y+20}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
  await page.waitForTimeout(300);await count(page,1);assert.notDeepEqual((await snapshot(page)).pose,pose);
  await page.screenshot({path:`${output}/touch-marker.png`});
  await page.locator('#fit-scene').tap();await page.waitForTimeout(1000);
  await page.locator('#edit-mode').tap();
  const touchHead=await page.evaluate(async()=>{
    const {controller:c}=await import('/app.js');const p=c.session.markers.items[0].visual.screenPosition();
    const rect=document.querySelector('canvas').getBoundingClientRect();return {x:p.x+rect.left,y:p.y+rect.top};
  });
  const touchDestination=await project(page,[1,0,-.2]);
  await page.touchscreen.tap(touchHead.x,touchHead.y);
  await page.getByRole('button',{name:'Magenta',exact:true}).tap();
  await page.locator('#marker-note').fill('Touch note');await page.locator('#save-marker').tap();
  assert.equal((await snapshot(page)).markers[0].color,'magenta');
  assert.equal((await snapshot(page)).markers[0].note,'Touch note');
  await page.locator('#marker-name').fill('Touch route');await page.locator('#save-marker').tap();
  await assertEditorLayout(page);
  const touchTypePose=(await snapshot(page)).pose;
  await page.locator('#marker-type-reference').tap();
  assert.equal((await snapshot(page)).markers[0].type,'reference');
  await page.locator('#marker-type-route').tap();
  assert.equal((await snapshot(page)).markers[0].type,'route');
  assert.deepEqual((await snapshot(page)).pose,touchTypePose);
  await page.locator('.marker-label').waitFor({state:'visible'});
  await page.screenshot({path:`${output}/touch-route-label.png`});
  assert.equal(await page.locator('#marker-editor').evaluate(panel=>panel.getBoundingClientRect().right<=innerWidth),true);
  await page.screenshot({path:`${output}/touch-metadata.png`});
  // Deselect before starting a drag: the compact editor overlaps this head.
  await page.touchscreen.tap(15,300);
  const dragPose=(await snapshot(page)).pose;
  const dragSession=await context.newCDPSession(page);
  const labelBox=await page.locator('.marker-label').boundingBox();
  const labelStart={x:labelBox.x+labelBox.width/2,y:labelBox.y+labelBox.height/2};
  await page.touchscreen.tap(labelStart.x,labelStart.y);
  assert.equal((await snapshot(page)).state.selectedMarkerId,1);
  await page.touchscreen.tap(15,300);
  await dragSession.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,...labelStart}]});
  await dragSession.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x:labelStart.x+touchDestination.x-touchHead.x,y:labelStart.y+touchDestination.y-touchHead.y}]});
  // Give Chrome's native gesture pipeline a realistic move-to-release interval;
  // instantaneous CDP drags can suppress the next toolbar tap's native click.
  await page.waitForTimeout(150);
  await dragSession.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await dragSession.detach();
  await page.waitForFunction(async()=> (await import('/app.js')).controller.markers[0].anchor.position[0]>.5);
  assert.deepEqual((await snapshot(page)).pose,dragPose);
  assert.equal((await snapshot(page)).markers[0].note,'Touch note');
  await page.locator('#marker-type-reference').tap();
  await page.locator('#marker-name').fill('Touch reference');await page.locator('#save-marker').tap();
  assert.equal((await snapshot(page)).markers[0].name,'Touch reference');
  await page.locator('.marker-label').waitFor({state:'visible'});
  assert.equal((await snapshot(page)).markers[0].note,'Touch note');
  await page.screenshot({path:`${output}/touch-reference.png`});
  await page.touchscreen.tap(15,300);
  await page.locator('.marker-label').waitFor({state:'visible'});
  const referenceBox=await page.locator('.marker-label').boundingBox();
  const referenceStart={x:referenceBox.x+referenceBox.width/2,y:referenceBox.y+referenceBox.height/2};
  const beforeReference=(await snapshot(page)).markers[0].anchor.position;
  const referencePose=(await snapshot(page)).pose;
  const referenceDrag=await context.newCDPSession(page);
  await referenceDrag.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,...referenceStart}]});
  await referenceDrag.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x:referenceStart.x-25,y:referenceStart.y}]});
  await page.waitForTimeout(150);
  await referenceDrag.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await referenceDrag.detach();
  await page.waitForFunction(async before=>{
    const {controller:c}=await import('/app.js');
    return c.markers[0].anchor.position.some((value,i)=>Math.abs(value-before[i])>.01);
  },beforeReference);
  assert.deepEqual((await snapshot(page)).pose,referencePose);
  assert.equal((await snapshot(page)).state.selectedMarkerId,1);
  await page.waitForTimeout(400);
  await page.locator('#delete-marker').tap();
  await page.screenshot({path:`${output}/touch-label-delete.png`});
  assert.equal((await snapshot(page)).markers.length,0,'Touch editor deletion after reference label drag');
  await count(page,0);
  report.checks.push('Touch emulation: select and drag route/reference labels without camera movement and delete using the editor');
  await page.locator('#close-scene').tap();await count(page,0);
  assert.equal(await page.locator('canvas').count(),0);
  report.checks.push('Touch: tap adds a marker without focus; two-finger pan/zoom changes camera without adding markers; close clears scene');
  assert.deepEqual(report.errors,[]);
  console.log(JSON.stringify(report,null,2));
} finally {
  await writeFile(`${output}/report.json`,JSON.stringify(report,null,2)+'\n');
  await browser.close();server.closeAllConnections();server.close();
}
