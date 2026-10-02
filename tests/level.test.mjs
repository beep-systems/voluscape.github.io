import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateLevel, sampleWorldCenters } from '../viewer/level.js';

function plane(a=.3,b=.1) {
  const p=[];
  for(let x=-10;x<=10;x++) for(let z=-10;z<=10;z++) p.push([x,a*x+b*z+(x%3)*.005,z]);
  return p;
}
test('recovers a tilted plane despite peripheral floaters and aligns its normal to +Y',()=>{
  const input=plane();
  for(let i=0;i<80;i++) input.push([i%17-8,(i%13)-6,i%19-9]);
  const result=estimateLevel(input);
  assert.ok(result && result.support>.75);
  assert.ok(Math.abs(result.tiltDegrees-Math.atan(Math.hypot(.3,.1))*180/Math.PI)<.2);
  const [x,y,z,w]=result.quaternion, n=result.normal;
  const uv=[y*n[2]-z*n[1],z*n[0]-x*n[2],x*n[1]-y*n[0]];
  const uuv=[y*uv[2]-z*uv[1],z*uv[0]-x*uv[2],x*uv[1]-y*uv[0]];
  const rotated=n.map((v,i)=>v+2*w*uv[i]+2*uuv[i]);
  assert.ok(Math.abs(rotated[0])<1e-7 && Math.abs(rotated[1]-1)<1e-7 && Math.abs(rotated[2])<1e-7);
  assert.deepEqual(estimateLevel(input),result);
});
test('rejects insufficient points, line-shaped clouds, vertical walls and excessive corrections',()=>{
  assert.equal(estimateLevel([[0,0,0]]),null);
  assert.equal(estimateLevel(Array.from({length:200},(_,i)=>[i,.3*i,i])),null);
  assert.equal(estimateLevel(plane().map(([x,y,z])=>[x,z,0])),null);
  assert.equal(estimateLevel(plane(2,0)),null);
});
test('already horizontal plane receives essentially identity correction; geometry is unchanged',()=>{
  const p=plane(0,0), before=structuredClone(p);
  const r=estimateLevel(p);
  assert.ok(r && r.tiltDegrees<.1);
  assert.deepEqual(p,before);
});
test('world-center sampling honors the entity transform and the sample budget',()=>{
  const centers=new Float32Array(Array.from({length:300},(_,i)=>i));
  const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,5,6,7,1];
  const p=sampleWorldCenters(centers,matrix,10);
  assert.equal(p.length,10); assert.deepEqual(p[0],[5,7,9]);
});
