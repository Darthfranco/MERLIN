import * as THREE from './vendor/three/build/three.module.min.js';
import { GLTFLoader } from './vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from './vendor/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/three/examples/jsm/postprocessing/OutputPass.js';
import { collectScreens,drawMessage,drawCanvasDemo,syncScreenAspect } from './screens.js';
import {ScreenHandoff,beginScreenEdit} from './screen-layout.js';
import { MotionController } from './motion.js';
import {visibleScreens,stateScreens,contentDestination,isFaceState} from './motion-routes.js';
import { SceneClock } from './scene-clock.js';
import { SceneOverlays } from './overlays/scene-overlays.js';
import { PANEL_TYPES,createDemoState,paintPanel,loadPanelArt } from './panels/render.js';

const $=id=>document.getElementById(id);
const canvas=$('scene'),stage=$('stage');
let controller,screens,renderer,composer,stateDefinitions,handoff,panelArt={};
const contentRevision={right:0,left:0,camera:0};
let sceneClock, sceneOverlays;
const dismissals=['dismiss-left','dismiss-right','dismiss-both'];
const controls=['mode','play','apply','canvas-demo','pause','ready','body','dock-left','dock-right','screen-image','panel-design','panel-side','show-panel','preview-timer','preview-music','clear-overlays',...dismissals];
controls.forEach(id=>$(id).disabled=true);
for(const {id,label} of PANEL_TYPES)$('panel-design').add(new Option(label,id));
$('retry').addEventListener('click',()=>location.reload());
function fail(error){
  sceneOverlays?.destroy();
  sceneClock?.destroy();
  $('loading').hidden=true;$('stage-error').hidden=false;
  $('error-detail').textContent=error.message||'Try reloading, or open the Blender file.';
  controls.forEach(id=>$(id).disabled=true);
  console.error(error);
}

async function start(){
  // Complete this one load before enabling editing. Late art can never replace
  // text, uploaded images, or a newer panel selected after merlinready.
  const artReady=loadPanelArt().catch(error=>{console.warn('Panel illustration unavailable:',error);return {};});
  const response=await fetch('../states.json');if(!response.ok)throw new Error('The character files are unavailable. Start this page with the included local server.');
  const manifest=await response.json();
  stateDefinitions=manifest.states;
  const footprintResponse=await fetch('./motion-footprints.json');
  if(!footprintResponse.ok)throw new Error('The clock layout data is unavailable. Reload the preview.');
  const footprintData=await footprintResponse.json();
  renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.AgXToneMapping;
  renderer.toneMappingExposure=1;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.VSMShadowMap;
  const scene=new THREE.Scene();scene.background=new THREE.Color('#081326');scene.fog=new THREE.Fog('#081326',22,50);
  const width=manifest.camera.orthographic_width,height=width/manifest.camera.aspect_ratio;
  const camera=new THREE.OrthographicCamera(-width/2,width/2,height/2,-height/2,.1,100);
  const basis=new THREE.Matrix4().makeRotationX(-Math.PI/2);
  const cameraMatrix=new THREE.Matrix4().set(...manifest.camera.matrix_world.flat());
  cameraMatrix.premultiply(basis).decompose(camera.position,camera.quaternion,camera.scale);
  const hemi=new THREE.HemisphereLight(0xb3d4ff,0x172b48,.65);scene.add(hemi);
  function light(color,intensity,x,y,z,shadow=false){
    const l=new THREE.DirectionalLight(color,intensity);l.position.set(x,y,z);l.target.position.set(0,2.2,0);
    if(shadow){l.castShadow=true;l.shadow.mapSize.set(1024,1024);Object.assign(l.shadow.camera,{left:-7,right:7,top:8,bottom:-5,near:.1,far:35});l.shadow.normalBias=.025;l.shadow.bias=-.00015;l.shadow.radius=4;l.shadow.blurSamples=8;l.shadow.intensity=.5;}
    scene.add(l,l.target);return l;
  }
  light(0xdbeeff,1.8,-3,8,6,true);light(0x92bfff,.65,5,4,3);light(0x5b9cff,2,0,5,-4);
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(100,100),new THREE.MeshStandardMaterial({color:0x01030a,roughness:.86,metalness:0}));
  floor.rotation.x=-Math.PI/2;floor.position.y=.024;floor.receiveShadow=true;scene.add(floor);
  const loader=new GLTFLoader();
  const [gltf,art]=await Promise.all([loader.loadAsync('../merlin-states.glb',progress=>{
    if(progress.total)$('loading').textContent='Loading MERLIN… '+Math.round(progress.loaded/progress.total*100)+'%';
  }),artReady]);
  panelArt=art;
  gltf.scene.traverse(obj=>{if(obj.isMesh){obj.castShadow=true;obj.receiveShadow=true;obj.frustumCulled=false;}});
  scene.add(gltf.scene);screens=collectScreens(gltf.scene);
  for(const name of ['right','left','camera'])if(!screens[name])throw new Error('Missing editable '+name+' screen. Rebuild the character export.');
  screens.ceiling=screens.right;
  handoff=new ScreenHandoff(screens);
  const feet=[];
  for(const name of ['footL','footR','foot_L','foot_R','foot.L','foot.R']){
    const foot=gltf.scene.getObjectByName(name);if(!foot)continue;
    const glow=new THREE.PointLight(0x26bcff,2.8,1.1,2);scene.add(glow);feet.push({foot,glow});
  }
  const mixer=new THREE.AnimationMixer(gltf.scene);
  sceneClock=new SceneClock(stage,manifest.states,new Map(Object.entries(footprintData.clips)),manifest.routes);
  sceneOverlays=new SceneOverlays(stage,{clock:sceneClock,onChange:updateOverlayStatus});
  controller=new MotionController(mixer,gltf.animations,manifest,info=>{
    handoff.sync(info.clip);
    sceneClock.sync({...info,current:info.state});
    updateOverlayStatus();
    const label=manifest.states[info.phase==='idle'?info.state:info.desired].label;
    const message=info.phase==='finishLoop'?'Finishing '+manifest.states[info.state].label.toLowerCase()+'…':info.phase==='idle'?label:'Moving to '+label.toLowerCase()+'…';
    $('motion-status').textContent=(info.paused?'Paused · ':'')+message;
    $('pause').textContent=info.paused?'Resume':'Pause';
    updateDismissals(info.desired,info.bodyContext);
    $('body').disabled=!isFaceState(info.state,stateDefinitions)&&!isFaceState(info.desired,stateDefinitions);
  });
  composer=new EffectComposer(renderer);composer.addPass(new RenderPass(scene,camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(800,600),.32,.25,1.1));composer.addPass(new OutputPass());
  function resize(){const w=stage.clientWidth,h=stage.clientHeight;renderer.setSize(w,h,false);composer.setSize(w,h);}
  new ResizeObserver(resize).observe(stage);resize();
  const clock=new THREE.Clock();let elapsed=0;
  renderer.setAnimationLoop(()=>{
    const dt=Math.min(clock.getDelta(),.05);if(!controller.paused)elapsed+=dt;
    controller.update(dt);
    handoff.sync(controller.clip);
    for(const id of visibleScreens(controller)){syncScreenAspect(screens[id]);if(!controller.paused)screens[id]?.tick(elapsed);}
    for(const {foot,glow} of feet){foot.getWorldPosition(glow.position);glow.position.y=.12;}
    composer.render();
  });
  canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();renderer.setAnimationLoop(null);fail(new Error('The graphics context was interrupted. Reload to resume.'));});
  Object.defineProperty(window,'merlin',{value:{
    overlays:sceneOverlays,
    screens,showPanel,dismissScreen,dockScreen,go:state=>controller.go(state),body:()=>controller.body(),ready:()=>controller.ready(),pause:()=>controller.pause(),resume:()=>controller.resume(),
    get state(){return controller.current;},get desired(){return controller.desired;},get phase(){return controller.phase;},get clip(){return controller.clip;},
    get bodyContext(){return controller.bodyContext;},
    get clock(){return {spot:sceneClock.spot?.id,hidden:sceneClock.plan.hidden};},
  }});
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)controller.pause();
  controls.forEach(id=>$(id).disabled=false);updateDismissals(controller.desired,controller.bodyContext);$('body').disabled=true;$('loading').hidden=true;
  const query=new URLSearchParams(location.search);
  if(query.has('panel')){
    try{showPanel(query.get('panel'),{},query.get('side')||'right');}
    catch(error){$('panel-status').textContent=error.message;}
  }
  window.dispatchEvent(new Event('merlinready'));
}

function showPanel(type,data={},target='right'){
  if(!PANEL_TYPES.some(panel=>panel.id===type))throw new TypeError('Choose a supported MERLIN panel design.');
  if(!['right','left','ceiling'].includes(target))throw new TypeError('Choose the left, right, or ceiling screen.');
  if(!data||typeof data!=='object'||Array.isArray(data))throw new TypeError('Panel data must be an object.');
  if(!screens||!controller)throw new Error('Wait until MERLIN is ready to show a panel.');
  const state={...createDemoState(type),...data,type};
  beginEdit(target).commit(screen=>screen.draw((ctx,w,h,t)=>paintPanel(ctx,w,h,state,{art:panelArt,time:t}),{reflow:false}));
  showSurface(target);
  $('panel-design').value=type;$('panel-side').value=target;$('screen-target').value=target;
  $('content-status').textContent='';
  $('panel-status').textContent=PANEL_TYPES.find(panel=>panel.id===type).label+' preview on the '+target+' panel.';
  return state;
}

$('animation-form').addEventListener('submit',event=>{event.preventDefault();controller?.go($('mode').value);});
$('panel-form').addEventListener('submit',event=>{
  event.preventDefault();
  try{showPanel($('panel-design').value,{},$('panel-side').value);}
  catch(error){$('panel-status').textContent=error.message;}
});
$('preview-timer').addEventListener('click',()=>previewOverlay('timer'));
$('preview-music').addEventListener('click',()=>previewOverlay('music'));
$('clear-overlays').addEventListener('click',()=>{sceneOverlays?.clear();updateOverlayStatus();});
function previewOverlay(type){
  const data=type==='timer'
    ? {title:'Tea timer',status:'running',remainingSeconds:242,durationSeconds:300}
    : {title:'Slow mornings',artist:'MERLIN sessions',status:'playing',positionSeconds:84,durationSeconds:218};
  sceneOverlays.show(type,data,{onAction:({id,action})=>{
    sceneOverlays.update(id,{status:action==='pause'?'paused':type==='timer'?'running':'playing'});
    updateOverlayStatus();
  }});
  updateOverlayStatus();
}
function updateOverlayStatus(){
  const cards=sceneOverlays?.status||[];
  if(!cards.length){$('overlay-status').textContent='No floating overlays.';return;}
  const visible=cards.filter(card=>card.visible).length;
  const text=`${cards.length} sample${cards.length===1?'':'s'} added. ${visible} visible${visible<cards.length?'; the rest will return when the scene has room':''}.`;
  if($('overlay-status').textContent!==text)$('overlay-status').textContent=text;
}
$('ready').addEventListener('click',()=>{controller.ready();$('mode').value='ready';});
$('body').addEventListener('click',()=>{controller.body();selectMode(controller.desired);});
$('pause').addEventListener('click',()=>controller.paused?controller.resume():controller.pause());
function updateDismissals(state,bodyContext){
  const context=isFaceState(state,stateDefinitions)?bodyContext:state;
  const visible=stateScreens(context),ceiling=context?.replace(/Think$/,'')==='ceiling';
  $('dismiss-left').disabled=!visible.includes('left');
  $('dismiss-right').disabled=!visible.includes('right');
  $('dismiss-both').disabled=!visible.some(side=>side==='left'||side==='right');
  $('dismiss-right').textContent=ceiling?'Dismiss screen':'Dismiss right';
  $('dock-left').disabled=!ceiling;$('dock-right').disabled=!ceiling;
}
function dockScreen(side){
  if(!['left','right'].includes(side))throw new RangeError('Move the screen left or right.');
  controller.go(side);selectMode(side);return controller;
}
for(const side of ['left','right'])$('dock-'+side).addEventListener('click',()=>dockScreen(side));
function dismissScreen(side){
  if(!controller)throw new Error('Wait until MERLIN is ready to dismiss a screen.');
  controller.dismissScreen(side);selectMode(controller.desired);
  return controller;
}
for(const side of ['left','right','both'])$('dismiss-'+side).addEventListener('click',()=>dismissScreen(side));
function showSurface(target){
  const destination=contentDestination(controller,target);
  controller.go(destination);selectMode(destination);
}
function selectMode(state){
  $('mode').value=[...$('mode').options].some(option=>option.value===state)?state:state.endsWith('Think')?'bodyThink':state==='walkRest'?'walk':state==='walkReverseRest'?'walkReverse':'ready';
}
function beginEdit(target=$('screen-target').value){return beginScreenEdit(screens,contentRevision,controller,target);}
function showContent(message,target=$('screen-target').value){
  showSurface(target);$('content-status').textContent=message;
  if(target===$('panel-side').value)$('panel-status').textContent='';
}
$('screen-form').addEventListener('submit',event=>{
  event.preventDefault();if(!screens)return;
  beginEdit().commit(screen=>drawMessage(screen,$('screen-title').value,$('screen-body').value));showContent('Your text is on the screen.');
});
$('canvas-demo').addEventListener('click',()=>{beginEdit().commit(drawCanvasDemo);showContent('The canvas is live. Edit its drawing function in code.');});
$('screen-image').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file||!screens)return;
  const target=$('screen-target').value,edit=beginEdit(target);
  try{
    if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('Choose a PNG, JPEG, or WebP image.');
    if(file.size>20*1024*1024)throw new Error('Choose an image smaller than 20 MB.');
    const image=await createImageBitmap(file);
    let applied;try{applied=edit.commit(screen=>screen.setSource(image));}finally{image.close();}
    if(applied)showContent('Your image is on the '+(target==='camera'?'viewfinder':target+' panel')+'.',target);
  }catch(error){if(edit.valid())$('content-status').textContent=error.message;}
  event.target.value='';
});
start().catch(fail);
