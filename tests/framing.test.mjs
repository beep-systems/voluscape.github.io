import test from 'node:test';
import assert from 'node:assert/strict';
import { framingBounds, framePose } from '../viewer/framing.js';
import { sampleWorldCenters } from '../viewer/level.js';

test('framing uses transformed world centers and trims distant outliers', () => {
  const centers = Float32Array.from(Array.from({ length: 200 }, (_, i) => [i / 199, i / 199, i / 199]).flat());
  const matrix = [1,0,0,0, 0,0,1,0, 0,-1,0,0, 50,60,70,1];
  const points = sampleWorldCenters(centers, matrix);
  const bounds = framingBounds([...points, [-1e6,-1e6,-1e6], [1e6,1e6,1e6]]);
  assert.ok(bounds.min[0] >= 50 && bounds.max[0] <= 51);
  assert.ok(bounds.min[1] >= 59 && bounds.max[1] <= 60);
  assert.ok(bounds.min[2] >= 70 && bounds.max[2] <= 71);
  assert.equal(points.length, 200);
  assert.equal(sampleWorldCenters(new Float32Array(15000), matrix).length, 4000);
});

test('small clouds keep all finite centers; invalid/degenerate clouds use resource bounds', () => {
  const fallback = { min: [-10,-20,-30], max: [10,20,30] };
  assert.deepEqual(framingBounds([[1,2,3], [100,200,300], [NaN,0,0]]), { min: [1,2,3], max: [100,200,300] });
  for (const points of [[], [[NaN,0,0]], [[1,1,1]]]) {
    assert.equal(framingBounds(points, fallback), fallback);
    assert.equal(framingBounds(points), null);
  }
  assert.equal(framingBounds([], { min: [0,0,0], max: [0,0,0] }), null);
});

test('frame sphere fits both canvas axes at landscape and portrait sizes', () => {
  const bounds = { min: [90,-4,30], max: [110,4,36] };
  const radius = Math.hypot(10,4,3);
  for (const [width, height] of [[1600,900], [900,1600], [800,800]]) {
    const pose = framePose(bounds, [2,2,-2], 85, width, height);
    assert.deepEqual(pose.target, [100,0,33]);
    assert.ok(pose.position[0] > 100 && pose.position[1] > 0 && pose.position[2] < 33);
    const minorAngle = Math.atan(Math.tan(85 * Math.PI / 360) * Math.min(width,height) / Math.max(width,height));
    assert.ok(Math.asin(radius / pose.distance) < minorAngle);
  }
  assert.equal(framePose(bounds, [0,0,0], 85, 800,800), null);
  assert.equal(framePose(bounds, [1,1,1], NaN, 800,800), null);
  assert.equal(framePose(bounds, [1,1,1], 85, 0,800), null);
});
