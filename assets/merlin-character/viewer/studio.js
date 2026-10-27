import * as THREE from './vendor/three/build/three.module.min.js';
import { GLTFLoader } from './vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from './vendor/three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/three/examples/jsm/postprocessing/OutputPass.js';
import { collectScreens,drawMessage,drawCanvasDemo } from './screens.js';
import { MotionController } from './motion.js';
import { PANEL_TYPES,createDemoState,paintPanel,loadPanelArt } from './panels/render.js';

const $=id=>document.getElementById(id);
const canvas=$('scene'),stage=$('stage');
let controller,screens,renderer,composer,panelArt={};
const contentRevision={right:0,left:0,camera:0};
const controls=['mode','play','apply','canvas-demo','pause','ready','screen-image','panel-design','panel-side','show-panel'];
controls.forEach(id=>$(id).disabled=true);
for(const {id,label} of PANEL_TYPES)$('panel-design').add(new Option(label,id));
$('retry').addEventListener('click',()=>location.reload());
function fail(error){
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
  const feet=[];
  for(const name of ['footL','footR','foot_L','foot_R','foot.L','foot.R']){
    const foot=gltf.scene.getObjectByName(name);if(!foot)continue;
    const glow=new THREE.PointLight(0x26bcff,2.8,1.1,2);scene.add(glow);feet.push({foot,glow});
  }
  const mixer=new THREE.AnimationMixer(gltf.scene);
  controller=new MotionController(mixer,gltf.animations,manifest,info=>{
    const label=manifest.states[info.phase==='idle'?info.state:info.desired].label;
    const message=info.phase==='finishLoop'?'Finishing '+manifest.states[info.state].label.toLowerCase()+'…':info.phase==='idle'?label:'Moving to '+label.toLowerCase()+'…';
    $('motion-status').textContent=(info.paused?'Paused · ':'')+message;
    $('pause').textContent=info.paused?'Resume':'Pause';
  });
  composer=new EffectComposer(renderer);composer.addPass(new RenderPass(scene,camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(800,600),.32,.25,1.1));composer.addPass(new OutputPass());
  function resize(){const w=stage.clientWidth,h=stage.clientHeight;renderer.setSize(w,h,false);composer.setSize(w,h);}
  new ResizeObserver(resize).observe(stage);resize();
  const clock=new THREE.Clock();let elapsed=0;
  renderer.setAnimationLoop(()=>{
    const dt=Math.min(clock.getDelta(),.05);if(!controller.paused)elapsed+=dt;
    controller.update(dt);
    if(!controller.paused)for(const [id,screen] of Object.entries(screens))if(id===controller.current||id===controller.arrival)screen.tick(elapsed);
    for(const {foot,glow} of feet){foot.getWorldPosition(glow.position);glow.position.y=.12;}
    composer.render();
  });
  canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();renderer.setAnimationLoop(null);fail(new Error('The graphics context was interrupted. Reload to resume.'));});
  Object.defineProperty(window,'merlin',{value:{
    screens,showPanel,go:state=>controller.go(state),ready:()=>controller.go('ready'),pause:()=>controller.pause(),resume:()=>controller.resume(),
    get state(){return controller.current;},get desired(){return controller.desired;},get phase(){return controller.phase;},get clip(){return controller.clip;},
  }});
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)controller.pause();
  controls.forEach(id=>$(id).disabled=false);$('loading').hidden=true;
  const query=new URLSearchParams(location.search);
  if(query.has('panel')){
    try{showPanel(query.get('panel'),{},query.get('side')||'right');}
    catch(error){$('panel-status').textContent=error.message;}
  }
  window.dispatchEvent(new Event('merlinready'));
}

function showPanel(type,data={},target='right'){
  if(!PANEL_TYPES.some(panel=>panel.id===type))throw new TypeError('Choose a supported MERLIN panel design.');
  if(!['right','left'].includes(target))throw new TypeError('Panel designs fit the left or right panel.');
  if(!data||typeof data!=='object'||Array.isArray(data))throw new TypeError('Panel data must be an object.');
  if(!screens||!controller)throw new Error('Wait until MERLIN is ready to show a panel.');
  const state={...createDemoState(type),...data,type};
  contentRevision[target]++;
  screens[target].draw((ctx,w,h,t)=>paintPanel(ctx,w,h,state,{art:panelArt,time:t}));
  controller.go(target);$('mode').value=target;
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
$('ready').addEventListener('click',()=>{controller.go('ready');$('mode').value='ready';});
$('pause').addEventListener('click',()=>controller.paused?controller.resume():controller.pause());
function selected(){return screens[$('screen-target').value];}
function showContent(message,target=$('screen-target').value){
  controller.go(target);$('mode').value=target;$('content-status').textContent=message;
  if(target===$('panel-side').value)$('panel-status').textContent='';
}
$('screen-form').addEventListener('submit',event=>{
  event.preventDefault();if(!screens)return;
  contentRevision[$('screen-target').value]++;
  drawMessage(selected(),$('screen-title').value,$('screen-body').value);showContent('Your text is on the screen.');
});
$('canvas-demo').addEventListener('click',()=>{contentRevision[$('screen-target').value]++;drawCanvasDemo(selected());showContent('The canvas is live. Edit its drawing function in code.');});
$('screen-image').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file||!screens)return;
  const target=$('screen-target').value,screen=screens[target];
  const revision=++contentRevision[target];
  try{
    if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('Choose a PNG, JPEG, or WebP image.');
    if(file.size>20*1024*1024)throw new Error('Choose an image smaller than 20 MB.');
    const image=await createImageBitmap(file);
    if(revision!==contentRevision[target]){image.close();return;}
    screen.draw((ctx,w,h)=>{ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);const scale=Math.min(w/image.width,h/image.height);const sw=image.width*scale,sh=image.height*scale;ctx.drawImage(image,(w-sw)/2,(h-sh)/2,sw,sh);});
    image.close();showContent('Your image is on the '+(target==='camera'?'viewfinder':target+' panel')+'.',target);
  }catch(error){$('content-status').textContent=error.message;}
  event.target.value='';
});
start().catch(fail);
