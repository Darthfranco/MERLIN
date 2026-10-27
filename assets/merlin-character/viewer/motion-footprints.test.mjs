import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AnimationClip,AnimationMixer,Bone,BoxGeometry,BufferAttribute,BufferGeometry,Group,Mesh,MeshBasicMaterial,NumberKeyframeTrack,OrthographicCamera,Skeleton,SkinnedMesh,Vector3 } from './vendor/three/build/three.module.min.js';
import { buildMotionFootprints } from './motion-footprints.js';
import { loadFootprintSource } from '../scripts/build_motion_footprints.mjs';
import { chooseClockSpot,clockMotionPlan } from './clock-layout.js';
import {transitionEdges} from './motion-routes.js';

function camera(){const value=new OrthographicCamera(-5,5,5,-5,.1,100);value.position.z=10;value.updateMatrixWorld(true);return value;}
function movingBox(){
  const root=new Group(),mesh=new Mesh(new BoxGeometry(1,1,1),new MeshBasicMaterial());mesh.name='traveler';root.add(mesh);
  const clip=new AnimationClip('round trip',2,[new NumberKeyframeTrack('traveler.position[x]',[0,1,2],[-3,3,-3])]);
  return {root,mesh,clip};
}

test('whole-cycle footprints include travel in both directions and restore the original pose',()=>{
  const {root,mesh,clip}=movingBox();mesh.position.set(.25,.5,0);
  const rect=buildMotionFootprints(root,[clip],camera()).get(clip.name)[0];
  assert.ok(rect.left<.15&&rect.right>.85);assert.ok(rect.top<.41&&rect.bottom>.5);
  assert.deepEqual(mesh.position.toArray(),[.25,.5,0]);
});

test('separate objects stay separate and zero-scale helpers do not block anchors',()=>{
  const {root,clip}=movingBox();
  const helper=new Mesh(new BoxGeometry(50,50,1),new MeshBasicMaterial());helper.name='hidden helper';helper.scale.setScalar(0);root.add(helper);
  const staticMesh=new Mesh(new BoxGeometry(.5,.5,.5),new MeshBasicMaterial());staticMesh.name='prop';staticMesh.position.set(4,4,0);root.add(staticMesh);
  const rects=buildMotionFootprints(root,[clip],camera()).get(clip.name);
  assert.equal(rects.length,2);assert.ok(rects.some(rect=>rect.object==='prop'));assert.ok(rects.every(rect=>rect.object!=='hidden helper'));
});

test('bone-driven motion moves the footprint even when the mesh transform is stationary',()=>{
  const root=new Group(),bone=new Bone();bone.name='arm';root.add(bone);
  const geometry=new BufferGeometry();geometry.setAttribute('position',new BufferAttribute(new Float32Array([0,0,0,1,0,0,1,1,0,0,1,0]),3));
  geometry.setAttribute('skinIndex',new BufferAttribute(new Uint16Array(16),4));
  geometry.setAttribute('skinWeight',new BufferAttribute(new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0]),4));
  const mesh=new SkinnedMesh(geometry,new MeshBasicMaterial());mesh.name='hand';root.add(mesh);mesh.bind(new Skeleton([bone]));
  const clip=new AnimationClip('reach',1,[new NumberKeyframeTrack('arm.position[x]',[0,1],[0,3])]);
  const rect=buildMotionFootprints(root,[clip],camera()).get('reach')[0];
  assert.ok(rect.left<.5&&rect.right>.9);assert.equal(bone.position.x,0);assert.equal(mesh.position.x,0);
});

test('cached footprints match the current GLB and authored camera and cover every clip',async()=>{
  const source=await loadFootprintSource();
  const data=JSON.parse(await readFile(new URL('./motion-footprints.json',import.meta.url),'utf8'));
  assert.equal(data.assetSha256,source.assetSha256,'Regenerate motion footprints after changing the GLB.');
  assert.equal(data.cameraSha256,source.cameraSha256,'Regenerate motion footprints after changing the camera.');
  assert.deepEqual(Object.keys(data.clips).sort(),source.gltf.animations.map(clip=>clip.name).sort());
  for(const [name,rects] of Object.entries(data.clips)){
    assert.ok(rects.length>0,name);
    for(const rect of rects)assert.ok(rect.left>=0&&rect.top>=0&&rect.right<=1&&rect.bottom<=1&&rect.right>rect.left&&rect.bottom>rect.top,name+' '+rect.object);
  }
  // Independently deform real exported vertices at deliberately off-grid times.
  // These samples cover the walker reversing, ballistic prop, live panels,
  // shattering fragments, dancing notes, nap and the supported return hop.
  const cases=[['WalkWhistle',[.47,2.37,4.23,6.43]],['WallToss',[1.23,3.17,6.37]],['PanelIdle',[.37]],['LeftPanelIdle',[.63]],['PanelToReady',[2.17]],['LeftPanelToReady',[2.13]],['Dance',[2.77]],['Nap',[2.47]],['NapToReady',[2.13]]];
  const extended=new Set(['ReadyToBothPanels','BothPanelsIdle','BothToLeftPanel','BothToRightPanel','BothPanelsToReady','SeatedLeftPanelIdle','SeatedRightPanelIdle','SeatedLeftToReady','SeatedRightToReady']);
  for(const clip of source.gltf.animations)if(/Thinking|ToThink|ThinkToBody|Paused|ToFace$|^FaceTo|WhistleReverse|Ceiling/.test(clip.name))extended.add(clip.name);
  for(const name of extended){
    const clip=source.gltf.animations.find(value=>value.name===name);
    cases.push([name,[clip.duration*.173,clip.duration*.617]]);
  }
  const mixer=new AnimationMixer(source.gltf.scene),point=new Vector3();
  for(const [name,times] of cases){
    const clip=source.gltf.animations.find(value=>value.name===name),action=mixer.clipAction(clip).play();
    const rects=new Map(data.clips[name].map(rect=>[rect.object,rect]));
    for(const time of times){
      action.time=time;mixer.update(0);source.gltf.scene.updateMatrixWorld(true);
      source.gltf.scene.traverse(mesh=>{
        if(!mesh.isMesh)return;
        const rect=rects.get(mesh.name);
        const count=mesh.geometry.attributes.position.count;
        let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity,escapedVertex=null;
        for(let vertex=0;vertex<count;vertex++){
          mesh.getVertexPosition(vertex,point).applyMatrix4(mesh.matrixWorld).project(source.camera);
          const x=(point.x+1)/2,y=(1-point.y)/2;
          if(x<0||x>1||y<0||y>1||point.z< -1||point.z>1)continue;
          left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
          if(rect&&!(x>=rect.left-1e-6&&x<=rect.right+1e-6&&y>=rect.top-1e-6&&y<=rect.bottom+1e-6))escapedVertex??=vertex;
        }
        // A shard's collapsed origin need not lie inside its later visible path.
        // Match the production subpixel/zero-scale visibility threshold first.
        if(!Number.isFinite(left)||(right-left)*(bottom-top)<1e-6)return;
        assert.ok(rect,`${name} at ${time}: visible ${mesh.name} is missing`);
        assert.equal(escapedVertex,null,`${name} at ${time}: ${mesh.name} vertex ${escapedVertex} escaped footprint`);
      });
    }
    action.stop();
  }
});

test('authored full activity cycles leave a safe large-clock anchor on mobile and desktop',async()=>{
  const data=JSON.parse(await readFile(new URL('./motion-footprints.json',import.meta.url),'utf8'));
  const {states,routes}=JSON.parse(await readFile(new URL('../states.json',import.meta.url),'utf8'));
  for(const width of [358,896])for(const state of Object.keys(states)){
    const motion={current:state,desired:state,phase:'idle',clip:states[state].idle};
    const plan=clockMotionPlan(motion,states,routes);if(plan.hidden)continue;
    const obstacles=(plan.occlusionClips||plan.clips).flatMap(clip=>data.clips[clip]);
    const spot=chooseClockSpot({width,height:width*.75,clockWidth:width*.27,clockHeight:width*.14,obstacles});
    assert.equal(spot.overlap,0,`${width}px ${state} has no clear anchor`);
  }
});

test('both panel exits and opposite entries individually leave a clear clock route',async()=>{
  const data=JSON.parse(await readFile(new URL('./motion-footprints.json',import.meta.url),'utf8'));
  for(const width of [358,896])for(const route of [
    ['PanelIdle','PanelToReady'],['ReadyToLeftPanel','LeftPanelIdle'],
    ['LeftPanelIdle','LeftPanelToReady'],['ReadyToPanel','PanelIdle'],
    ['BothPanelsIdle','BothToLeftPanel','SeatedLeftPanelIdle'],
    ['BothPanelsIdle','BothToRightPanel','SeatedRightPanelIdle'],
  ]){
    const spot=chooseClockSpot({width,height:width*.75,clockWidth:width*.27,clockHeight:width*.14,obstacles:route.flatMap(clip=>data.clips[clip])});
    assert.equal(spot.overlap,0,`${width}px ${route.join(' → ')} has no clear anchor`);
  }
});

test('every visible destination pair and interrupted transition retains a safe anchor with real footprints',async()=>{
  const data=JSON.parse(await readFile(new URL('./motion-footprints.json',import.meta.url),'utf8'));
  const {states,routes}=JSON.parse(await readFile(new URL('../states.json',import.meta.url),'utf8'));
  const edges=transitionEdges(states,routes);
  for(const width of [358,896])for(const [state,definition] of Object.entries(states))for(const desired of Object.keys(states)){
    const motions=[{current:state,desired,phase:'idle',clip:definition.idle}];
    for(const edge of edges.filter(edge=>edge.from===state))motions.push({current:state,arrival:edge.to,desired,phase:edge.phase,clip:edge.clip});
    if(['walk','toss'].includes(state))motions.push({current:state,arrival:state,desired,phase:'finishLoop',clip:definition.idle});
    for(const motion of motions){
      const plan=clockMotionPlan(motion,states,routes);if(plan.hidden)continue;
      const obstacles=plan.occlusionClips.flatMap(clip=>data.clips[clip]);
      const spot=chooseClockSpot({width,height:width*.75,clockWidth:width*.27,clockHeight:width*.14,obstacles});
      assert.equal(spot.overlap,0,`${width}px ${state} → ${desired} (${motion.phase}) has no clear anchor`);
    }
  }
});
