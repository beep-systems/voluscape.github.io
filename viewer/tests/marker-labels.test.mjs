import test from 'node:test';
import assert from 'node:assert/strict';
import { MarkerLabels } from '../marker-labels.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 180));
function setup() {
  const element = () => ({ style: {}, dataset: {}, hidden: false, listeners: new Map(),
    addEventListener(name, handler) { this.listeners.set(name,handler); },
    removeEventListener(name) { this.listeners.delete(name); }, append() {}, remove() { this.removed = true; } });
  globalThis.document = { createElement: element };
  const camera = { entity: { getWorldTransform: () => ({ data: [pose] }) }, projectionMatrix: { data: [1] } };
  let pose = 0, opacity = 0, point = { x: 50, y: 40, depth: 10 };
  const hooks = new Map(), picks = [];
  const viewer = { app: {
    on: (name, handler) => hooks.set(name, handler), off: name => hooks.delete(name),
    root: { findComponents: () => [camera] },
    graphicsDevice: { canvas: { getBoundingClientRect: () => ({ width: 100, height: 100, left: 0, top: 0 }) } }
  }, pickVisibility: async (points, radius) => { picks.push({ points, radius }); return [opacity]; } };
  const markers = { items: [{ record: { id: 1, type: 'reference', name: '<b>Text</b>' }, visual: { screenPosition: () => point } }] };
  const host = { ...element(), getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const labels = new MarkerLabels(viewer, markers, host);
  return { labels, viewer, picks, hooks, markers, setPose: value => { pose = value; }, setOpacity: value => { opacity = value; }, setPoint: value => { point = value; } };
}

test('labels use plain text, approximate splat visibility and camera pose even if projection stays fixed', async () => {
  const context = setup(); const { labels, picks } = context;
  labels.refresh(); const label = labels.labels.get(1);
  assert.equal(label.textContent, '<b>Text</b>'); assert.equal(label.hidden, true);
  await settle(); assert.equal(label.hidden, false);
  assert.deepEqual(picks[0], { points: [{ x: .5, y: .4, depth: 9 }], radius: .13 });
  context.setOpacity(.6); context.setPose(1); labels.refresh();
  assert.equal(label.hidden, true); await settle(); assert.equal(label.hidden, true);
  context.setPoint(null); labels.refresh(); assert.equal(label.hidden, true);
  context.setPoint({ x: 200, y: 40, depth: 10 }); labels.refresh(); assert.equal(label.hidden, true);
  labels.destroy(); assert.equal(context.hooks.size, 0); assert.equal(labels.layer.removed, true);
});

test('pending label visibility cannot restore removed or destroyed labels', async () => {
  const { labels, viewer, markers } = setup(); let resolve;
  viewer.pickVisibility = () => new Promise(done => { resolve = done; });
  labels.refresh(); const label = labels.labels.get(1); await settle();
  markers.items[0].record.name = ''; labels.refresh(); resolve([0]); await Promise.resolve();
  assert.equal(label.hidden, true); assert.equal(label.removed, true);
  markers.items[0].record.type = 'route'; markers.items[0].record.name = 'Route label'; labels.refresh(); await settle();
  const replacement = labels.labels.get(1); labels.destroy(); resolve([0]); await Promise.resolve();
  assert.equal(replacement.hidden, true);
});

test('route labels exist only for saved nonblank names and survive type conversion', async () => {
  const { labels, markers } = setup();
  markers.items[0].record.type = 'route'; markers.items[0].record.name = '';
  labels.refresh(); assert.equal(labels.labels.size,0);
  markers.items[0].record.name = '   '; labels.refresh(); assert.equal(labels.labels.size,0);
  markers.items[0].record.name = 'Trail junction'; labels.refresh(); await settle();
  const label = labels.labels.get(1); assert.equal(label.hidden,false);
  markers.items[0].record.type = 'reference'; labels.refresh(); assert.equal(labels.labels.get(1),label);
  markers.items[0].record.type = 'route'; labels.refresh(); assert.equal(labels.labels.get(1),label);
  markers.items[0].record.name = ''; labels.refresh(); assert.equal(labels.labels.size,0);
  labels.destroy();
});

test('visible labels delegate their ID, hidden/removed labels do not, and handlers are disposed', async () => {
  const { labels, markers } = setup();
  markers.mode = 'edit-markers';
  const gestures = []; markers.handlePointer = (event,id) => gestures.push(id);
  labels.refresh(); const label = labels.labels.get(1);
  const event = { target: { closest: () => label } };
  labels.onPointerDown(event); assert.deepEqual(gestures,[]);
  await settle(); labels.onPointerDown(event); assert.deepEqual(gestures,[1]);
  assert.equal(labels.layer.dataset.mode,'edit-markers');
  markers.mode = 'add-marker'; labels.refresh();
  assert.equal(labels.layer.dataset.mode,'add-marker');
  labels.onPointerDown(event); assert.deepEqual(gestures,[1]);
  markers.items.length = 0; labels.refresh(); labels.onPointerDown(event);
  assert.deepEqual(gestures,[1]);
  labels.destroy(); assert.equal(labels.layer.listeners.size,0);
});
