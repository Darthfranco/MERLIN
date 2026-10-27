import { createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from '../viewer/vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { Matrix4,OrthographicCamera } from '../viewer/vendor/three/build/three.module.min.js';
import { buildMotionFootprints } from '../viewer/motion-footprints.js';

const assetURL=new URL('../merlin-states.glb',import.meta.url);
const manifestURL=new URL('../states.json',import.meta.url);
const outputURL=new URL('../viewer/motion-footprints.json',import.meta.url);
export const sha256=value=>createHash('sha256').update(value).digest('hex');

// Node can evaluate all authored geometry, bones, morphs and animation tracks.
// Remove only material references to avoid loading browser-only image textures.
export async function loadFootprintSource(){
  const [source,manifestText]=await Promise.all([readFile(assetURL),readFile(manifestURL,'utf8')]);
  const manifest=JSON.parse(manifestText),jsonLength=source.readUInt32LE(12);
  const json=JSON.parse(source.subarray(20,20+jsonLength).toString());
  for(const mesh of json.meshes)for(const primitive of mesh.primitives)delete primitive.material;
  json.materials=[];json.textures=[];json.images=[];
  const encoded=Buffer.from(JSON.stringify(json));
  const padded=Buffer.alloc(Math.ceil(encoded.length/4)*4,32);encoded.copy(padded);
  const binary=source.subarray(20+jsonLength),buffer=Buffer.alloc(20+padded.length+binary.length);
  buffer.writeUInt32LE(0x46546c67,0);buffer.writeUInt32LE(2,4);buffer.writeUInt32LE(buffer.length,8);
  buffer.writeUInt32LE(padded.length,12);buffer.writeUInt32LE(0x4e4f534a,16);
  padded.copy(buffer,20);binary.copy(buffer,20+padded.length);
  const gltf=await new GLTFLoader().parseAsync(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.length),'');
  const width=manifest.camera.orthographic_width,height=width/manifest.camera.aspect_ratio;
  const camera=new OrthographicCamera(-width/2,width/2,height/2,-height/2,.1,100);
  const matrix=new Matrix4().set(...manifest.camera.matrix_world.flat()).premultiply(new Matrix4().makeRotationX(-Math.PI/2));
  matrix.decompose(camera.position,camera.quaternion,camera.scale);camera.updateMatrixWorld(true);
  return {gltf,camera,manifest,assetSha256:sha256(source),cameraSha256:sha256(JSON.stringify(manifest.camera))};
}

export async function generateFootprints(){
  const {gltf,camera,assetSha256,cameraSha256}=await loadFootprintSource();
  const sampleRate=48,padding=.008;
  const footprints=buildMotionFootprints(gltf.scene,gltf.animations,camera,{sampleRate,padding});
  const clips=Object.fromEntries([...footprints].map(([name,rectangles])=>[name,rectangles.map(rect=>({
    ...rect,left:Math.floor(rect.left*1e6)/1e6,top:Math.floor(rect.top*1e6)/1e6,
    right:Math.ceil(rect.right*1e6)/1e6,bottom:Math.ceil(rect.bottom*1e6)/1e6,
  }))]));
  const data={version:1,assetSha256,cameraSha256,sampleRate,padding,clips};
  await writeFile(outputURL,JSON.stringify(data)+'\n');
  console.log(`Saved ${footprints.size} animation footprints to ${fileURLToPath(outputURL)}`);
  return data;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await generateFootprints();
