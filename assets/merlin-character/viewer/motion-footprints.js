import { AnimationMixer,Box3,LoopOnce,Matrix4,Vector3 } from './vendor/three/build/three.module.min.js';

// Use envelopes around the vertices influenced by each bone. Every skinned
// vertex is a weighted average of those transformed envelopes, so their union
// contains it without skinning the entire mesh again at every sampled frame.
function meshEnvelopes(mesh){
  const geometry=mesh.geometry,positions=geometry.attributes.position;
  const indices=geometry.attributes.skinIndex,weights=geometry.attributes.skinWeight;
  const morphs=geometry.morphAttributes.position||[];
  const boxes=new Map(),point=new Vector3(),low=new Vector3(),high=new Vector3(),delta=new Vector3();
  const add=(key)=>{
    let box=boxes.get(key);if(!box){box=new Box3();boxes.set(key,box);}
    box.expandByPoint(low);box.expandByPoint(high);
  };
  for(let vertex=0;vertex<positions.count;vertex++){
    point.fromBufferAttribute(positions,vertex);low.copy(point);high.copy(point);
    // Exported facial weights are bounded to 0–1. Include every simultaneous
    // blend, not just the individual target boxes. Dormant display helpers
    // disappear through their animated scale before projection below.
    for(const morph of morphs){
      delta.fromBufferAttribute(morph,vertex);
      if(!geometry.morphTargetsRelative)delta.sub(point);
      low.x+=Math.min(0,delta.x);low.y+=Math.min(0,delta.y);low.z+=Math.min(0,delta.z);
      high.x+=Math.max(0,delta.x);high.y+=Math.max(0,delta.y);high.z+=Math.max(0,delta.z);
    }
    if(mesh.isSkinnedMesh&&indices&&weights){
      for(let influence=0;influence<weights.itemSize;influence++){
        if(weights.getComponent(vertex,influence)>0)add(indices.getComponent(vertex,influence));
      }
    }else add(null);
  }
  return [...boxes].map(([bone,box])=>({bone,box}));
}

function isVisible(object){
  for(let node=object;node;node=node.parent)if(!node.visible)return false;
  const materials=Array.isArray(object.material)?object.material:[object.material];
  return materials.some(material=>material?.visible!==false);
}

/**
 * Predict the space each animated mesh occupies during an entire clip.
 *
 * Returns Map<clipName, Array<{left,top,right,bottom,object}>>. Coordinates are
 * normalized to the camera viewport, with (0,0) at top left. Each rectangle is
 * one mesh's swept envelope, not a single box surrounding the complete scene.
 * Call once after loading the model, before creating its playback controller.
 * All original transforms and morph weights are restored, even after failure.
 */
export function buildMotionFootprints(root,clips,camera,{sampleRate=48,padding=.008}={}){
  if(!camera.isOrthographicCamera)throw new TypeError('Motion footprints require the authored orthographic camera.');
  if(!Number.isFinite(sampleRate)||sampleRate<=0||!Number.isFinite(padding)||padding<0)throw new RangeError('Invalid footprint sampling options.');
  const saved=[],meshes=[],result=new Map();
  root.traverse(object=>{
    saved.push({object,position:object.position.clone(),quaternion:object.quaternion.clone(),scale:object.scale.clone(),matrix:object.matrix.clone(),morphs:object.morphTargetInfluences?.slice()});
    if(object.isMesh&&object.geometry.attributes.position)meshes.push({object,envelopes:meshEnvelopes(object)});
  });
  camera.updateWorldMatrix(true,false);
  const viewProjection=new Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
  const transform=new Matrix4(),skin=new Matrix4(),point=new Vector3();
  const mixer=new AnimationMixer(root);
  try{
    for(const clip of clips){
      const footprints=new Map();
      const action=mixer.clipAction(clip).reset().setLoop(LoopOnce,1);
      action.clampWhenFinished=true;action.play();
      const steps=Math.max(1,Math.ceil(clip.duration*sampleRate));
      for(let step=0;step<=steps;step++){
        // Direct action time avoids accumulating drift and samples both ends.
        action.time=clip.duration*step/steps;mixer.update(0);
        root.parent?.updateWorldMatrix(true,false);root.updateMatrixWorld(true);
        for(const {object,envelopes} of meshes){
          if(!isVisible(object))continue;
          let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity,near=Infinity,far=-Infinity;
          for(const {bone,box} of envelopes){
            transform.copy(object.matrixWorld);
            if(bone!==null){
              const skeleton=object.skeleton;
              skin.multiplyMatrices(skeleton.bones[bone].matrixWorld,skeleton.boneInverses[bone]);
              transform.multiply(object.bindMatrixInverse).multiply(skin).multiply(object.bindMatrix);
            }
            transform.premultiply(viewProjection);
            for(let corner=0;corner<8;corner++){
              point.set(corner&1?box.max.x:box.min.x,corner&2?box.max.y:box.min.y,corner&4?box.max.z:box.min.z).applyMatrix4(transform);
              const x=(point.x+1)/2,y=(1-point.y)/2;
              left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
              near=Math.min(near,point.z);far=Math.max(far,point.z);
            }
          }
          if(far< -1||near>1)continue;
          left=Math.max(0,left);right=Math.min(1,right);top=Math.max(0,top);bottom=Math.min(1,bottom);
          // Zero-scale helpers, off-camera props, and subpixel fragments are
          // not obstacles. Padding follows this test, so hidden objects never
          // create an artificial obstacle at their collapsed origin.
          if(right<=left||bottom<=top||(right-left)*(bottom-top)<1e-6)continue;
          const previous=footprints.get(object);
          if(previous){
            previous.left=Math.min(previous.left,left);previous.top=Math.min(previous.top,top);
            previous.right=Math.max(previous.right,right);previous.bottom=Math.max(previous.bottom,bottom);
          }else footprints.set(object,{left,top,right,bottom,object:object.name});
        }
      }
      // Half-frame sampling plus a small viewport margin covers motion between
      // authored 24fps poses and keeps the clock clear of the visible silhouette.
      result.set(clip.name,[...footprints.values()].map(rect=>({
        ...rect,left:Math.max(0,rect.left-padding),top:Math.max(0,rect.top-padding),
        right:Math.min(1,rect.right+padding),bottom:Math.min(1,rect.bottom+padding),
      })));
      action.stop();mixer.uncacheClip(clip);
    }
  }finally{
    mixer.stopAllAction();mixer.uncacheRoot(root);
    for(const {object,position,quaternion,scale,matrix,morphs} of saved){
      object.position.copy(position);object.quaternion.copy(quaternion);object.scale.copy(scale);object.matrix.copy(matrix);
      if(morphs)object.morphTargetInfluences.splice(0,morphs.length,...morphs);
    }
    root.parent?.updateWorldMatrix(true,false);root.updateMatrixWorld(true);
  }
  return result;
}
