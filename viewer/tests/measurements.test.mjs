import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneMeasurements, parseMeters } from '../measurements.js';

function setup() {
  const visuals = [];
  const viewer = {
    async pickSurface(x, y) { return { position: [x, y, 0] }; },
    createMarkerVisual(hit) {
      // Simulate picking in rotated display space and conversion to source space.
      const visual = { anchor: { componentIndex: 0, position: [-hit.position[1], hit.position[0], 0] },
        destroy() { this.destroyed = true; }, alignToSceneUp() {} };
      visuals.push(visual); return visual;
    },
    createMarkerConnection() { return { destroy() {}, update() {} }; }
  };
  return { viewer, visuals, m: new SceneMeasurements(viewer, .1) };
}
const pin = (id, position, type = 'route') => ({ id, type, anchor: { position } });

test('metric calibration uses converted source anchors, skips references and sums unrounded distances', async () => {
  const { m, visuals } = setup(); m.begin(); await m.pick(0, 0); await m.pick(3, 4); m.apply('10,0');
  assert.equal(m.snapshot.calibration.metersPerUnit, 2);
  assert.ok(visuals.every(v => v.destroyed));
  let route = [pin(1, [0, 0, 0]), pin(2, [99, 99, 99], 'reference'), pin(3, [3, 4, 0]), pin(4, [3, 4, 2])];
  assert.deepEqual(m.measure(route), { segments: [{ fromId: 1, toId: 3, meters: 10 }, { fromId: 3, toId: 4, meters: 4 }], totalMeters: 14 });
  route[2].anchor.position = [0, 0, 0]; assert.equal(m.measure(route).totalMeters, Math.hypot(3, 4, 2) * 2);
  route.splice(2, 1); assert.equal(m.measure(route).segments.length, 1);
  route[1].type = 'route'; assert.equal(m.measure(route).segments.length, 2);
  route.splice(1, 0, pin(8, [1, 0, 0])); assert.equal(m.measure(route).segments.length, 3);
  const snapshot = m.snapshot; snapshot.calibration.points[0].position[0] = 99;
  assert.ok(m.snapshot.calibration.points[0].position[0] === 0);
  m.updateOrientation(); assert.equal(m.snapshot.calibration.metersPerUnit, 2);
});

test('input rejects invalid distances; duplicate B, background and recalibration cancellation preserve state', async () => {
  for (const value of ['0', '-1', '', 'Infinity', 'NaN', '4m', '1,2.3', '1e309']) assert.throws(() => parseMeters(value));
  assert.equal(parseMeters(' .5 '), .5); assert.equal(parseMeters('4,25'), 4.25);
  const { m, viewer } = setup(); m.begin(); await m.pick(0, 0); await m.pick(0, 0);
  assert.equal(m.points.length, 1); assert.match(m.message, /different/);
  await m.pick(1, 0); assert.throws(() => m.apply('0')); assert.equal(m.points.length, 2);
  m.apply(4); m.begin(); await m.pick(2, 0); m.cancel(); assert.equal(m.calibration.metersPerUnit, 4);
  m.begin(); await m.pick(0, 0); await m.pick(2, 0); m.apply(12);
  assert.equal(m.calibration.metersPerUnit, 6);
  m.begin(); viewer.pickSurface = async () => null; await m.pick(0, 0); assert.equal(m.points.length, 0);
  m.destroy(); assert.equal(m.measure([pin(1, [0, 0, 0]), pin(2, [1, 0, 0])]).totalMeters, null);
});

test('serial picks and stale completion after cancel, orientation or destruction cannot add points', async () => {
  for (const action of ['cancel', 'updateOrientation', 'destroy']) {
    const { m, viewer } = setup(); let resolve, calls = 0;
    viewer.pickSurface = () => { calls++; return new Promise(r => { resolve = r; }); };
    m.begin(); const pending = m.pick(0, 0); await m.pick(1, 0); assert.equal(calls, 1);
    m[action](); resolve({ position: [1, 0, 0] }); await pending; assert.equal(m.points.length, 0);
  }
});
