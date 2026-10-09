import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneMarkers, markerPalette, hitMarkerSegment } from '../markers.js';

const bounds = { min: [0, 0, 0], max: [3, 4, 0] };
const hit = { position: [1, 2, 3], normal: [0, 1, 0] };
test('creation and repeated manual selection carry distinct editor intent', async () => {
  const { markers } = setup(), changes = [];
  markers.onChanged = change => changes.push(change);
  markers.setMode('add-marker');
  await markers.addAt(.5, .5);
  assert.deepEqual(changes.at(-1), { type: 'selection', id: 1, source: 'creation' });
  markers.setMode('edit-markers');
  markers.select(1);
  assert.deepEqual(changes.at(-1), { type: 'selection', id: 1, source: 'manual' });
  markers.select(1);
  assert.deepEqual(changes.at(-1), { type: 'selection', id: 1, source: 'manual' });
  assert.equal(changes.length, 3);
});
const segment = (depth = 2) => ({ perspective: true,
  a: { x: 20, y: 50, depth, position: [0, 0, depth] },
  b: { x: 180, y: 50, depth: 8, position: [8, 4, 8] } });

test('segment hit interpolation corrects perspective and rejects misses/degenerate projections', () => {
  const picked = hitMarkerSegment(segment(), 100, 58);
  assert.deepEqual(picked.position, [1.6, .8, 3.2]);
  assert.equal(picked.depth, 3.2); assert.equal(picked.distance, 8);
  assert.deepEqual(hitMarkerSegment({ ...segment(), perspective: false }, 100, 50).position, [4, 2, 5]);
  assert.equal(hitMarkerSegment(segment(), 100, 58.1), null);
  assert.equal(hitMarkerSegment(null, 100, 50), null);
  assert.equal(hitMarkerSegment({ ...segment(), b: segment().a }, 20, 50), null);
});

async function insertionSetup() {
  const state = setup();
  const { markers, visuals } = state;
  markers.canvas = { getBoundingClientRect: () => ({ left: 10, top: 20 }), removeEventListener() {} };
  markers.setMode('add-marker');
  for (const type of ['route', 'reference', 'route', 'route']) {
    markers.setNewMarkerType(type); await markers.addAt(.5, .5);
  }
  for (const visual of visuals) visual.screenPosition = () => null;
  markers.setMode('edit-markers');
  markers.connections[0].screenSegment = () => segment();
  markers.connections[1].screenSegment = () => null;
  return state;
}

test('insertion skips references, preserves IDs, selects before added and supports subsequent edits', async () => {
  const { markers, added } = await insertionSetup();
  markers.updateMarker(1, { color: 'blue' }); markers.updateMarker(3, { color: 'blue' });
  const old = markers.connections[0], events = [];
  markers.onChanged = event => events.push(event.type);
  markers.onAdded = record => { events.push('added'); added.push(record); assert.equal(markers.selectedId, record.id); };
  markers.insertAt(110, 70);
  assert.deepEqual(markers.markers.map(record => record.id), [1, 2, 5, 3, 4]);
  assert.deepEqual(markers.connections.map(c => [c.fromMarker.record.id, c.toMarker.record.id]), [[1, 5], [5, 3], [3, 4]]);
  const record = markers.markers[2];
  assert.equal(record.color, 'blue'); assert.equal(record.name, ''); assert.equal(record.note, '');
  assert.equal(record.type, 'route'); assert.equal(markers.mode, 'edit-markers');
  assert.deepEqual(record.anchor.position, [1.6, .8 - .8 * markers.height, 3.2]);
  assert.deepEqual(events, ['selection', 'added']); assert.equal(old.destroyed, true);
  await markers.moveAt(5, .2, .2); assert.deepEqual(markers.markers[2].anchor.position, hit.position);
  markers.updateMarker(5, { type: 'reference' }); assert.equal(markers.connections.length, 2);
  markers.updateMarker(5, { type: 'route' }); assert.equal(markers.connections.length, 3);
  markers.deleteSelected(); assert.deepEqual(markers.markers.map(record => record.id), [1, 2, 3, 4]);
});

test('insertion picks closest projection then depth, respects heads, mode and mixed colors', async () => {
  const { markers, visuals } = await insertionSetup();
  markers.connections[0].screenSegment = () => segment(6);
  markers.connections[1].screenSegment = () => segment(2);
  markers.updateMarker(3, { color: 'blue' });
  visuals[0].screenPosition = () => ({ x: 100, y: 50, depth: 1 });
  markers.insertAt(110, 70); assert.equal(markers.markers.length, 4);
  visuals[0].screenPosition = () => null;
  markers.insertAt(110, 90); assert.equal(markers.markers.length, 4);
  markers.insertAt(110, 70);
  assert.deepEqual(markers.markers.map(record => record.id), [1, 2, 3, 5, 4]);
  assert.equal(markers.markers[3].color, 'red');
  markers.setMode('add-marker'); markers.insertAt(110, 70); assert.equal(markers.markers.length, 5);
  markers.destroy(); markers.insertAt(110, 70); assert.equal(markers.markers.length, 0);
});

test('failed second replacement connection disposes temporary objects without changing chain or IDs', async () => {
  const { markers, viewer, visuals, connections, errors } = await insertionSetup();
  const before = markers.markers, old = [...markers.connections], selected = markers.selectedId;
  const create = viewer.createMarkerConnection.bind(viewer); let calls = 0;
  viewer.createMarkerConnection = options => { if (++calls === 2) throw new Error('connection failed'); return create(options); };
  markers.insertAt(110, 70);
  assert.deepEqual(markers.markers, before); assert.deepEqual(markers.connections, old);
  assert.equal(markers.selectedId, selected); assert.equal(markers.nextId, 5);
  assert.equal(visuals.at(-1).destroyed, true); assert.equal(connections.at(-1).destroyed, true);
  assert.ok(old.every(connection => !connection.destroyed)); assert.equal(errors.length, 1);
  viewer.createMarkerConnection = create; markers.insertAt(110, 70);
  assert.equal(markers.selectedId, 5);
});

test('screen distance wins over depth and failed visual creation leaves the original route', async () => {
  const { markers, viewer, errors } = await insertionSetup();
  const farther = segment(1);
  farther.a.y += 4; farther.b.y += 4;
  markers.connections[1].screenSegment = () => farther;
  const before = markers.markers, old = [...markers.connections];
  const create = viewer.createMarkerVisual.bind(viewer);
  viewer.createMarkerVisual = () => { throw new Error('visual failed'); };
  markers.insertAt(110, 70);
  assert.deepEqual(markers.markers, before); assert.deepEqual(markers.connections, old);
  assert.equal(markers.nextId, 5); assert.equal(errors.length, 1);
  viewer.createMarkerVisual = create;
  markers.insertAt(110, 70);
  assert.deepEqual(markers.markers.map(record => record.id), [1, 2, 5, 3, 4]);
});
test('label gestures select by ID, preserve repeated selection and drag with a head offset', async () => {
  const { markers, visuals } = setup();
  const captured = new Set();
  let cursorHidden = false;
  markers.canvas = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 100 }),
    removeEventListener() {},
    ownerDocument: { documentElement: { toggleAttribute: (_, hidden) => { cursorHidden = hidden; } } },
    setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id),
    releasePointerCapture: id => captured.delete(id) };
  markers.setMode('add-marker'); await markers.addAt(.5,.5);
  visuals[0].screenPosition = () => ({ x: 50, y: 50, depth: 1 });
  markers.setMode('edit-markers');
  markers.select(null);
  const changes = []; markers.onChanged = change => changes.push(change);
  const event = (type, x = 40, y = 30) => ({ type, clientX: x, clientY: y, button: 0, pointerId: 1,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
  const picks = []; markers.viewer.pickSurface = async (x,y) => { picks.push([x,y]); return hit; };
  const down = event('pointerdown'); markers.handlePointer(down,1);
  assert.equal(markers.selectedId,1); assert.ok(down.prevented && down.stopped && captured.has(1));
  markers.handlePointer(event('pointermove',42,30)); assert.equal(picks.length,0);
  assert.equal(cursorHidden,false);
  markers.handlePointer(event('pointerup',42,30)); assert.equal(captured.size,0);
  markers.handlePointer(event('pointerdown'),1);
  assert.equal(changes.filter(change=>change.type==='selection').length,2);
  markers.handlePointer(event('pointermove',50,40));
  assert.equal(cursorHidden,true);
  assert.deepEqual(picks[0],[.6,.6]);
  markers.handlePointer(event('pointercancel')); assert.equal(captured.size,0);
  assert.equal(cursorHidden,false);
  await Promise.resolve(); assert.equal(changes.filter(change=>change.type==='moved').length,0);
  markers.handlePointer(event('pointerdown'),1); markers.handlePointer(event('lostpointercapture'));
  assert.equal(markers.drag,null);
  for (const end of [() => markers.handlePointer(event('pointerup',50,40)),
    () => markers.invalidate(), () => markers.setMode('add-marker'),
    () => markers.handlePointer(event('lostpointercapture'))]) {
    markers.setMode('edit-markers');
    markers.handlePointer(event('pointerdown'),1); markers.handlePointer(event('pointermove',50,40));
    assert.equal(cursorHidden,true); end(); assert.equal(cursorHidden,false);
  }
  markers.handlePointer(event('pointerdown'),99); assert.equal(captured.size,0);
  markers.setMode('add-marker'); markers.handlePointer(event('pointerdown'),1); assert.equal(captured.size,0);
  markers.setMode('edit-markers');
  markers.handlePointer(event('pointerdown'),1); markers.handlePointer(event('pointermove',50,40));
  markers.deleteSelected(); assert.equal(cursorHidden,false);
  markers.setMode('add-marker'); await markers.addAt(.5,.5);
  visuals[1].screenPosition = visuals[0].screenPosition;
  markers.setMode('edit-markers');
  markers.handlePointer(event('pointerdown'),2); markers.handlePointer(event('pointermove',50,40));
  assert.equal(cursorHidden,true); markers.destroy(); assert.equal(cursorHidden,false);
});
function setup(pickSurface = async () => hit) {
  const visuals = [], connections = [], added = [], errors = [];
  const viewer = {
    pickSurface,
    setPointInteraction(handler, cursor) { this.handler = handler; this.cursor = cursor; },
    createMarkerConnection(options) {
      const connection = { ...options, setColor(color) { this.color = color; }, update() { this.updated = true; }, destroy() { this.destroyed = true; this.materialDestroyed = true; } };
      connections.push(connection); return connection;
    },
    createMarkerVisual(options) {
      const visual = { anchor: { componentIndex: 0, position: options.position, normal: options.normal },
        setColor(color) { this.color = color; },
        alignToSceneUp() { this.aligned = true; },
        setSelected(selected) { this.selected = selected; },
        moveTo(hit) { this.anchor = { ...this.anchor, ...hit }; },
        destroy() { this.destroyed = true; } };
      visuals.push(visual); return visual;
    }
  };
  const markers = new SceneMarkers(viewer, bounds, { onAdded: marker => added.push(marker), onError: error => errors.push(error) });
  return { markers, viewer, visuals, connections, added, errors };
}

test('bulk route deletion preserves references, selection, IDs and mode with one notification', async () => {
  const { markers, visuals, connections } = setup();
  markers.setMode('add-marker');
  await markers.addAt(.5, .5);
  markers.setNewMarkerType('reference'); await markers.addAt(.5, .5);
  markers.updateMarker(2, { name: 'Spring', note: 'Keep', color: 'blue' });
  markers.setNewMarkerType('route'); await markers.addAt(.5, .5);
  markers.setNewMarkerType('reference'); await markers.addAt(.5, .5);
  const references = markers.markers.filter(marker => marker.type === 'reference');
  markers.setMode('edit-markers'); markers.select(2);
  const events = []; markers.onChanged = change => events.push(change);
  markers.deleteRouteMarkers();
  assert.deepEqual(markers.markers, references); assert.equal(markers.selectedId, 2);
  assert.equal(markers.mode, 'edit-markers'); assert.equal(markers.connections.length, 0);
  assert.ok(connections.every(c => c.destroyed && c.materialDestroyed));
  assert.deepEqual(visuals.map(v => !!v.destroyed), [true, false, true, false]);
  assert.deepEqual(events, [{ type: 'route-cleared', ids: [1, 3] }]);
  markers.deleteRouteMarkers(); assert.equal(events.length, 1);
  markers.setMode('add-marker'); markers.setNewMarkerType('route'); await markers.addAt(.5, .5);
  assert.equal(markers.selectedId, 5); markers.deleteRouteMarkers(); assert.equal(markers.selectedId, null);
  assert.equal(markers.mode, 'add-marker'); assert.deepEqual(markers.markers, references);
});

test('bulk deletion rejects pending add and move results, including an initially empty route', async () => {
  for (const operation of ['add', 'move', 'empty-add']) {
    const { markers, viewer } = setup(); markers.setMode('add-marker');
    if (operation !== 'empty-add') await markers.addAt(.5, .5);
    let resolve; viewer.pickSurface = () => new Promise(r => { resolve = r; });
    if (operation === 'move') markers.setMode('edit-markers');
    const pending = operation === 'move' ? markers.moveAt(1, .4, .4) : markers.addAt(.4, .4);
    markers.deleteRouteMarkers(); resolve(hit); await pending;
    assert.deepEqual(markers.markers, []); assert.equal(markers.connections.length, 0);
  }
});

test('adding selects each new pin, keeps add mode, preserves selection into edit and supports add-mode deletion', async () => {
  const { markers, viewer, visuals } = setup();
  const selections = [];
  markers.onChanged = change => { if (change.type === 'selection') selections.push(change.id); };
  markers.setMode('add-marker');
  await markers.addAt(.5, .5);
  assert.equal(markers.selectedId, 1);
  assert.equal(markers.mode, 'add-marker');
  assert.equal(viewer.cursor, 'crosshair');
  markers.setNewMarkerType('reference');
  await markers.addAt(.5, .5);
  assert.equal(markers.selectedId, 2);
  assert.equal(markers.markers[1].type, 'reference');
  assert.deepEqual(visuals.map(visual => visual.selected), [false, true]);
  markers.setMode('edit-markers');
  assert.equal(markers.selectedId, 2);
  markers.setMode('add-marker');
  assert.equal(markers.selectedId, null);
  await markers.addAt(.5, .5);
  markers.updateMarker(3, { name: 'Spring', note: 'Water', color: 'blue', type: 'route' });
  assert.equal(markers.markers[2].note, 'Water');
  markers.deleteSelected();
  assert.equal(markers.selectedId, null);
  assert.equal(markers.mode, 'add-marker');
  assert.equal(markers.markers.length, 2);
  assert.ok(visuals[2].destroyed);
  assert.deepEqual(selections, [1, 2, null, 3]);
  viewer.pickSurface = async () => null;
  await markers.addAt(.5, .5);
  assert.equal(markers.selectedId, null);
  markers.destroy();
});

test('reference pins are skipped by the route chain and conversion retains names and comments', async () => {
  const { markers, visuals } = setup();
  assert.equal(markers.mode, 'edit-markers'); assert.equal(markers.newMarkerType, 'route');
  assert.throws(() => markers.setMode('navigate'));
  assert.throws(() => markers.setNewMarkerType('other'));
  markers.setMode('add-marker'); await markers.addAt(.1,.1);
  markers.setNewMarkerType('reference'); await markers.addAt(.2,.2);
  assert.equal(markers.markers[1].name,'Reference 2'); assert.equal(markers.connections.length,0);
  markers.setNewMarkerType('route'); await markers.addAt(.3,.3);
  assert.equal(markers.connections.length,1);
  assert.equal(markers.connections[0].from,visuals[0]); assert.equal(markers.connections[0].to,visuals[2]);
  markers.updateMarker(2,{name:'Spring',note:'Water'});
  markers.updateMarker(2,{color:'blue'}); markers.updateMarker(2,{type:'route'});
  assert.equal(markers.connections.length,2); assert.equal(markers.markers[1].note,'Water');
  markers.updateMarker(2,{type:'reference'}); assert.equal(markers.connections.length,1);
  assert.equal(markers.markers[1].name,'Spring');
  markers.updateMarker(2,{name:'   '}); assert.equal(markers.markers[1].name,'Reference 2');
  const before=markers.markers;
  assert.throws(()=>markers.updateMarker(2,{color:'blue',note:42}));assert.deepEqual(markers.markers,before);
  markers.setMode('edit-markers'); markers.select(2); markers.deleteSelected();
  assert.equal(markers.connections.length,1);assert.equal(markers.markers.length,2);
  markers.updateMarker(1,{type:'reference'});assert.equal(markers.connections.length,0);
});

test('changing the next type does not change or cancel a point already being picked', async () => {
  let resolve; const { markers } = setup(() => new Promise(done => { resolve = done; }));
  markers.setMode('add-marker');
  const pending = markers.addAt(.5,.5); markers.setNewMarkerType('reference');
  resolve(hit); await pending;
  assert.equal(markers.markers[0].type,'route');assert.equal(markers.newMarkerType,'reference');
});
test('session markers share scene-relative size, immutable snapshots and deterministic cleanup', async () => {
  const { markers, viewer, visuals, added } = setup();
  await markers.addAt(.5, .5); assert.equal(markers.markers.length, 0);
  markers.setMode('add-marker');
  await markers.addAt(.5, .5); await markers.addAt(.6, .6);
  assert.deepEqual(added.map(marker => [marker.id, marker.height]), [[1, .05], [2, .05]]);
  const snapshot = markers.markers;
  snapshot[0].anchor.position[0] = 99;
  assert.equal(markers.markers[0].anchor.position[0], 1);
  markers.setMode('edit-markers'); assert.equal(typeof viewer.handler, 'function');
  assert.equal(markers.markers.length, 2);
  markers.destroy(); markers.destroy();
  assert.ok(visuals.every(visual => visual.destroyed));
  assert.deepEqual(markers.markers, []);
});

test('metadata defaults, palette validation, independent snapshots and equal/mixed chain colors', async () => {
  const { markers, visuals, viewer } = setup();
  const red = markerPalette.find(color => color.id === 'red').rgb;
  const blue = markerPalette.find(color => color.id === 'blue').rgb;
  markers.setMode('add-marker'); assert.equal(viewer.cursor, 'crosshair');
  for (let i = 0; i < 3; ++i) await markers.addAt(.5, .5);
  assert.ok(markers.markers.every(marker => marker.color === 'red' && marker.note === ''));
  markers.setMode('edit-markers'); assert.equal(viewer.cursor, 'pointer');
  const changes = []; markers.onChanged = change => changes.push(change);
  markers.updateMarker(1, { color: 'blue', note: 'Line 1\nLine 2 <b>plain text</b>' });
  assert.deepEqual(visuals[0].color, blue);
  assert.deepEqual(markers.connections.map(connection => connection.color), [red, red]);
  markers.updateMarker(2, { color: 'blue', note: '' });
  assert.deepEqual(markers.connections.map(connection => connection.color), [blue, red]);
  assert.equal(changes[0].type, 'metadata');
  const snapshot = markers.markers; snapshot[0].note = 'Changed'; snapshot[0].color = 'white';
  assert.equal(markers.markers[0].note, 'Line 1\nLine 2 <b>plain text</b>');
  assert.throws(() => markers.updateMarker(1, { color: 'unknown', note: '' }), TypeError);
  for (const color of ['orange','cyan']) assert.throws(() => markers.updateMarker(1, { color }), TypeError);
  assert.throws(() => markers.updateMarker(1, { color: 'red', note: 42 }), TypeError);
  markers.updateMarker(99, { color: 'blue', note: 'Missing ID' });
  assert.equal(changes.length, 2);
  markers.updateMarker(3, { color: 'blue', note: '' });
  const previous = [...markers.connections];
  markers.select(2); markers.deleteSelected();
  assert.deepEqual(markers.connections[0].color, blue);
  assert.ok(previous.every(connection => connection.materialDestroyed));
  markers.updateMarker(3, { color: 'yellow', note: 'Last' });
  assert.deepEqual(markers.connections[0].color, red);
  markers.setMode('edit-markers'); markers.updateOrientation();
  assert.equal(markers.markers[1].note, 'Last');
  markers.destroy(); assert.deepEqual(markers.markers, []);
});

test('editing moves source anchors and removes the middle pin with an adjacent reconnection', async () => {
  const { markers, visuals } = setup();
  markers.setMode('add-marker');
  for (let i = 0; i < 3; ++i) await markers.addAt(.5, .5);
  markers.setMode('edit-markers');
  markers.viewer.pickSurface = async () => ({ position: [4, 5, 6], normal: [0, 1, 0] });
  await markers.moveAt(2, .2, .3);
  assert.deepEqual(markers.markers[1].anchor.position, [4, 5, 6]);
  assert.ok(markers.connections.every(connection => connection.updated));
  markers.select(2);
  assert.equal(visuals[1].selected, true);
  const previous = [...markers.connections];
  markers.deleteSelected();
  assert.deepEqual(markers.markers.map(marker => marker.id), [1, 3]);
  assert.ok(previous.every(connection => connection.destroyed));
  assert.equal(visuals[1].destroyed, true);
  assert.equal(markers.connections.length, 1);
  assert.equal(markers.connections[0].from, visuals[0]);
  assert.equal(markers.connections[0].to, visuals[2]);
  markers.select(1); markers.deleteSelected();
  assert.equal(markers.connections.length, 0);
  markers.select(3); markers.deleteSelected();
  assert.equal(markers.markers.length, 0);
});

test('only the latest drag pick applies; background and cancelled picks do not move pins', async () => {
  const { markers } = setup();
  markers.setMode('add-marker'); await markers.addAt(.5, .5);
  markers.setMode('edit-markers');
  const pending = [];
  markers.viewer.pickSurface = () => new Promise(resolve => pending.push(resolve));
  const a = markers.moveAt(1, .1, .1), b = markers.moveAt(1, .2, .2);
  pending[1]({ position: [7, 8, 9] }); await b;
  pending[0](hit); await a;
  assert.deepEqual(markers.markers[0].anchor.position, [7, 8, 9]);
  const background = markers.moveAt(1, .3, .3); pending[2](null); await background;
  assert.deepEqual(markers.markers[0].anchor.position, [7, 8, 9]);
  for (const cancel of [() => markers.invalidate(), () => markers.setMode('edit-markers'), () => {
    markers.select(1); markers.deleteSelected();
  }, () => markers.destroy()]) {
    markers.setMode('edit-markers');
    const move = markers.moveAt(1, .4, .4);
    cancel(); pending.at(-1)(hit); await move;
    if (markers.markers.length) assert.deepEqual(markers.markers[0].anchor.position, [7, 8, 9]);
  }
});
test('consecutive pins form an open chain across mode switches, reorient and clear together', async () => {
  const { markers, visuals, connections } = setup();
  markers.setMode('add-marker');
  await markers.addAt(.1,.1);
  assert.equal(connections.length,0);
  await markers.addAt(.2,.2);
  markers.setMode('edit-markers');markers.setMode('add-marker');
  await markers.addAt(.3,.3);
  assert.equal(connections.length,2);
  assert.deepEqual(connections.map(connection=>[visuals.indexOf(connection.from),visuals.indexOf(connection.to)]),[[0,1],[1,2]]);
  markers.updateOrientation();assert.ok(connections.every(connection=>connection.updated));
  markers.destroy();assert.ok(connections.every(connection=>connection.destroyed));
  assert.equal(markers.connections.length,0);
});
for (const reason of ['mode', 'orientation', 'destroy']) {
  test(`pending surface pick is discarded after ${reason}`, async () => {
    let resolve;
    const { markers, visuals } = setup(() => new Promise(done => { resolve = done; }));
    markers.setMode('add-marker');
    const pending = markers.addAt(.5, .5);
    if (reason === 'mode') { markers.setMode('edit-markers'); markers.setMode('add-marker'); }
    else if (reason === 'orientation') markers.invalidate();
    else markers.destroy();
    resolve(hit); await pending;
    assert.equal(visuals.length, 0);
  });
}
test('background creates nothing; surface normals do not prevent placement; errors are recoverable', async () => {
  let next = null;
  const { markers, added, errors } = setup(async () => { if (next instanceof Error) throw next; return next; });
  markers.setMode('add-marker');
  await markers.addAt(.1, .1);
  next = { ...hit, normal: [0, 0, 0] }; await markers.addAt(.2, .2);
  next = new Error('readback'); await markers.addAt(.3, .3);
  assert.equal(errors.length, 1); assert.equal(added.length, 1);
  next = hit; await markers.addAt(.5, .5); assert.equal(added.length, 2);
});
