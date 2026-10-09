// Deterministic synthetic splats only: no owner footage or reconstruction outputs.
export const points = Array.from({ length: 21 * 21 }, (_, index) => {
  const x = (index % 21 - 10) / 5, z = (Math.floor(index / 21) - 10) / 5;
  // With upstream Z conversion and landing X rotation this is a gently tilted ground.
  return [x, z, -.2 * x - .1 * z];
});
export function gaussianPly() {
  const properties = ['x','y','z','f_dc_0','f_dc_1','f_dc_2','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3'];
  const header = Buffer.from(['ply','format binary_little_endian 1.0',`element vertex ${points.length}`,
    ...properties.map(name => `property float ${name}`),'end_header',''].join('\n'));
  const body = Buffer.alloc(points.length * properties.length * 4);
  points.forEach((point, index) => [...point,1,.3,.1,4,-2.5,-2.5,-2.5,1,0,0,0]
    .forEach((value, axis) => body.writeFloatLE(value, (index * properties.length + axis) * 4)));
  return Buffer.concat([header, body]);
}
export function compressedPly() {
  const names = ['min_x','min_y','min_z','max_x','max_y','max_z','min_scale_x','min_scale_y','min_scale_z','max_scale_x','max_scale_y','max_scale_z','min_r','min_g','min_b','max_r','max_g','max_b'];
  const chunks = Math.ceil(points.length / 256);
  const header = Buffer.from(['ply','format binary_little_endian 1.0',`element chunk ${chunks}`,
    ...names.map(name=>`property float ${name}`),`element vertex ${points.length}`,
    ...['packed_position','packed_rotation','packed_scale','packed_color'].map(name=>`property uint ${name}`),'end_header',''].join('\n'));
  const bounds = [[-2,-2,-.6],[2,2,.6]];
  const chunkData = Buffer.alloc(chunks * names.length * 4);
  for (let index=0;index<chunks;index++) [...bounds[0],...bounds[1],-2.5,-2.5,-2.5,-2.5,-2.5,-2.5,.8,.6,.5,.8,.6,.5]
    .forEach((value,axis)=>chunkData.writeFloatLE(value,(index*names.length+axis)*4));
  const data = Buffer.alloc(points.length * 16);
  points.forEach((point,index)=> {
    const values = point.map((value,axis)=>Math.round((value-bounds[0][axis])/(bounds[1][axis]-bounds[0][axis])*(axis===1?1023:2047)));
    data.writeUInt32LE(((values[0]<<21)|(values[1]<<11)|values[2])>>>0,index*16);
    data.writeUInt32LE(((3<<30)|(512<<20)|(512<<10)|512)>>>0,index*16+4);
    data.writeUInt32LE(0,index*16+8);
    data.writeUInt32LE(0xfffffffa,index*16+12);
  });
  return Buffer.concat([header,chunkData,data]);
}
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const records = [], central = [];
  let offset = 0;
  for (const [filename, data] of files) {
    const name = Buffer.from(filename), crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4);
    header.writeUInt32LE(crc,14); header.writeUInt32LE(data.length,18); header.writeUInt32LE(data.length,22); header.writeUInt16LE(name.length,26);
    records.push(header,name,data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20,4); directory.writeUInt16LE(20,6);
    directory.writeUInt32LE(crc,16); directory.writeUInt32LE(data.length,20); directory.writeUInt32LE(data.length,24); directory.writeUInt16LE(name.length,28); directory.writeUInt32LE(offset,42);
    central.push(directory,name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10);
  end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...records,directory,end]);
}
export async function packagedSog(sharp) {
  const width = 32, height = Math.ceil(points.length / width);
  const lo = Buffer.alloc(width * height * 4,255), hi = Buffer.from(lo);
  const encode = value => Math.sign(value) * Math.log(1 + Math.abs(value));
  const mins = [0,1,2].map(axis => Math.min(...points.map(p => encode(p[axis]))));
  const maxs = [0,1,2].map(axis => Math.max(...points.map(p => encode(p[axis]))));
  points.forEach((point,index) => point.forEach((value,axis) => {
    const encoded = Math.round((encode(value)-mins[axis])/(maxs[axis]-mins[axis])*65535);
    lo[index*4+axis] = encoded & 255; hi[index*4+axis] = encoded >>> 8;
  }));
  const rgba = pixel => Buffer.from(Array.from({length:width*height},()=>pixel).flat());
  const meta = { version:1,count:points.length,
    means:{mins,maxs,files:['means_l.webp','means_u.webp']},
    scales:{mins:[-2.5,-2.5,-2.5],maxs:[-2.5,-2.5,-2.5],files:['scales.webp']},
    quats:{files:['quats.webp']},sh0:{mins:[1,.3,.1,4],maxs:[1,.3,.1,4],files:['sh0.webp']} };
  const files = [['meta.json',Buffer.from(JSON.stringify(meta))]];
  for (const [name,data] of [['means_l.webp',lo],['means_u.webp',hi],['scales.webp',rgba([0,0,0,255])],['quats.webp',rgba([128,128,128,252])],['sh0.webp',rgba([128,128,128,255])]]) {
    files.push([name,await sharp(data,{raw:{width,height,channels:4}}).webp({lossless:true}).toBuffer()]);
  }
  return zip(files);
}
