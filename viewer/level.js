// Estimate a dominant near-horizontal surface, not physical gravity.
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const quantile = (values, fraction) => values[Math.floor((values.length - 1) * fraction)];
const extent = (points, axis) => { const values = points.map(p => p[axis]).sort((a,b)=>a-b); return [values[0], values.at(-1)]; };

export function estimateLevel(input) {
  const finite = input.filter(p => p.length === 3 && p.every(Number.isFinite));
  if (finite.length < 100) return null;
  // Reject peripheral floaters before fitting; keep source geometry intact.
  const ranges = [0,1,2].map(axis => {
    const values = finite.map(p=>p[axis]).sort((a,b)=>a-b);
    return [quantile(values,.02), quantile(values,.98)];
  });
  const points = finite.filter(p=>p.every((v,i)=>v>=ranges[i][0] && v<=ranges[i][1]));
  const diagonal = Math.hypot(...ranges.map(([a,b])=>b-a));
  if (points.length < 100 || diagonal < 1e-8) return null;
  const tolerance = diagonal * .008;
  const minimumY = Math.cos(35*Math.PI/180);
  let seed = 42;
  const random = () => { seed = (Math.imul(1664525,seed)+1013904223)>>>0; return seed/4294967296; };
  const hitsFor = (normal, offset) => points.filter(p=>Math.abs(dot(normal,p)+offset)<=tolerance);
  let best = [];
  for (let iteration = 0; iteration < 512; iteration++) {
    const [a,b,c] = [0,1,2].map(()=>points[Math.floor(random()*points.length)]);
    const u=b.map((v,i)=>v-a[i]), v=c.map((v,i)=>v-a[i]);
    let n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const length=Math.hypot(...n);
    if(length<diagonal*diagonal*1e-8) continue;
    n=n.map(value=>value/length*(n[1]<0?-1:1));
    if(n[1]<minimumY) continue; // Do not align a vertical facade as the ground.
    const hits=hitsFor(n,-dot(n,a));
    if(hits.length>best.length) best=hits;
  }
  if(best.length/points.length < .55) return null;
  // Refine y = a*x + b*z + c using centered least squares.
  const mean=best.reduce((m,p)=>m.map((v,i)=>v+p[i]/best.length),[0,0,0]);
  let xx=0,zz=0,xz=0,xy=0,zy=0;
  for(const p of best) {
    const x=p[0]-mean[0], y=p[1]-mean[1], z=p[2]-mean[2];
    xx+=x*x; zz+=z*z; xz+=x*z; xy+=x*y; zy+=z*y;
  }
  const determinant=xx*zz-xz*xz;
  if(xx===0 || zz===0 || determinant<xx*zz*.01) return null; // Line-shaped clouds have no reliable plane.
  const a=(xy*zz-zy*xz)/determinant, b=(zy*xx-xy*xz)/determinant;
  const length=Math.hypot(a,1,b);
  const normal=[-a/length,1/length,-b/length];
  if(normal[1]<minimumY) return null;
  best=hitsFor(normal,-dot(normal,mean));
  const support=best.length/points.length;
  if(support<.55) return null;
  for(const axis of [0,2]) {
    const [lo,hi]=extent(best,axis);
    if(hi-lo<(ranges[axis][1]-ranges[axis][0])*.5) return null;
  }
  // Shortest rotation from the inferred normal to world +Y; preserves heading
  // as far as possible and does not reverse the existing up direction.
  const q=[-normal[2],0,normal[0],1+normal[1]];
  const qLength=Math.hypot(...q);
  return { normal, quaternion:q.map(v=>v/qLength), tiltDegrees:Math.acos(Math.min(1,normal[1]))*180/Math.PI, support, sampledPoints:points.length };
}

export function sampleWorldCenters(centers, matrix, maxPoints = 4000) {
  const points=[];
  const count=Math.floor(centers.length/3);
  const size=Math.min(count,maxPoints);
  for(let i=0;i<size;i++) {
    const index=Math.floor(i*count/size)*3;
    const x=centers[index], y=centers[index+1], z=centers[index+2];
    points.push([matrix[0]*x+matrix[4]*y+matrix[8]*z+matrix[12], matrix[1]*x+matrix[5]*y+matrix[9]*z+matrix[13], matrix[2]*x+matrix[6]*y+matrix[10]*z+matrix[14]]);
  }
  return points;
}
