import test from 'node:test';
import assert from 'node:assert/strict';
import {Mesh,MeshStandardMaterial,PlaneGeometry} from './vendor/three/build/three.module.min.js';
import {ScreenSurface,surfaceBasis,syncScreenAspect,drawMessage} from './screens.js';
import {ScreenHandoff,beginScreenEdit,screenEditPlan} from './screen-layout.js';

class Context {
  constructor(){this.draws=[];this.transforms=[];this.clears=0;this.text=[];}
  save(){} restore(){} clearRect(){this.clears++;} fillRect(){} beginPath(){} rect(){} clip(){}
  fillText(text){this.text.push(text);}measureText(text){return {width:text.length*12};}
  setTransform(...values){this.transforms.push(values);}
  drawImage(source,...args){if(source.closed)throw new Error('Closed image');this.draws.push({source,args});}
}
class Canvas {constructor(){this.width=900;this.height=1080;this.context=new Context();}getContext(){return this.context;}}
class Bitmap {constructor(w=600,h=400){this.width=w;this.height=h;this.closed=false;}close(){this.closed=true;}}
class Picture {constructor(){this.width=this.naturalWidth=640;this.height=this.naturalHeight=480;}}
class Video {constructor(){this.videoWidth=1920;this.videoHeight=1080;this.readyState=2;}}
Object.assign(globalThis,{HTMLCanvasElement:Canvas,HTMLImageElement:Picture,HTMLVideoElement:Video,ImageBitmap:Bitmap,document:{createElement:()=>new Canvas()}});
const surface=id=>new ScreenSurface(id,[new MeshStandardMaterial()]);

test('text/code painters receive the physical screen aspect and static frames stay static',()=>{
  const screen=surface('right'),sizes=[];
  screen.draw((ctx,w,h)=>sizes.push([w,h]));assert.equal(sizes.length,1);
  for(let i=0;i<60;i++)screen.tick(i/60);assert.equal(sizes.length,1);
  screen.setAspect(8.5/5.4);assert.equal(sizes.length,2);
  assert.ok(Math.abs(sizes[1][0]/sizes[1][1]-8.5/5.4)<1e-10);
  screen.setAspect(8.5/5.4);assert.equal(sizes.length,2);
  assert.deepEqual([screen.canvas.width,screen.canvas.height],[900,1080],'No canvas reallocations during shape animation');
});

test('closed image bitmaps remain usable through wide resize and left handoff',()=>{
  const right=surface('right'),left=surface('left'),image=new Bitmap();
  right.setSource(image);const owned=right.content.source;assert.notEqual(owned,image);image.close();
  assert.doesNotThrow(()=>{right.setAspect(8.5/5.4);left.copyFrom(right);left.setAspect(5/6);left.update();});
  assert.equal(left.content.source,owned);
  const {args}=right.context.draws.at(-1);assert.ok(Math.abs(args[2]/args[3]-1.5)<1e-10,'Image ratio is preserved');
});

test('portrait designs contain-fit in a wide screen instead of stretching their type',()=>{
  const right=surface('right'),sizes=[];right.draw((ctx,w,h)=>sizes.push([w,h]),{reflow:false});right.setAspect(8.5/5.4);
  assert.ok(sizes.every(([w,h])=>w===900&&h===1080));
  const {args}=right.context.draws.at(-1);assert.equal(args[2]/args[3],5/6);
  assert.ok(args[0]>0,'The wide screen has side margins');
});

test('live painter, external canvas, and video sources survive handoff',()=>{
  const right=surface('right'),left=surface('left'),times=[];
  right.draw((ctx,w,h,t)=>times.push(t),{animate:true});left.copyFrom(right);left.tick(3.5);assert.equal(times.at(-1),3.5);
  const canvas=new Canvas();right.setSource(canvas);left.copyFrom(right);left.tick(4);
  assert.equal(left.context.draws.at(-1).source,canvas);
  const video=new Video();right.setSource(video);left.copyFrom(right);left.tick(5);
  assert.equal(left.context.draws.at(-1).source,video);assert.equal(left.autoUpdate,true);
  right.draw(()=>{});assert.equal(left.content.source,video,'Later right edits do not overwrite the handed-off content');
});

test('UV-derived dimensions follow actual animated scale independent of mesh rotation',()=>{
  const mesh=new Mesh(new PlaneGeometry(4.75,5.7),new MeshStandardMaterial());
  mesh.rotation.set(.8,.3,-.2);mesh.scale.set(8.5/4.75,5.4/5.7,1);
  const screen=surface('right');screen.basis=surfaceBasis(mesh);syncScreenAspect(screen);
  assert.ok(Math.abs(screen.aspect-8.5/5.4)<1e-6);
  mesh.scale.set(0,0,0);syncScreenAspect(screen);assert.ok(Number.isFinite(screen.aspect));
});

test('handoff copies once at entry, carries late edits through reveal, and leaves unrelated left content alone',()=>{
  const right=surface('right'),left=surface('left');let copies=0;const handoff=new ScreenHandoff({right,left},()=>copies++);
  left.draw(()=>{});const previous=left.content;handoff.sync('CeilingIdle');assert.equal(left.content,previous);
  right.draw(()=>{});handoff.sync('CeilingToLeftPanel');assert.equal(copies,1);
  handoff.sync('CeilingToLeftPanel');assert.equal(copies,1);
  right.draw(()=>{});handoff.sync('CeilingToLeftPanel');assert.equal(copies,2);
  right.draw(()=>{});handoff.sync('LeftPanelIdle');assert.equal(copies,3,'Final-frame edit is copied before reveal');
  right.draw(()=>{});handoff.sync('LeftPanelIdle');assert.equal(copies,3);
});

test('explicit left text, image, and code edits ride the ceiling card through body or full-face docking',()=>{
  for(const motion of [
    {current:'ceiling',desired:'ceiling',phase:'idle'},
    {current:'ceilingThink',desired:'ceilingThink',phase:'idle'},
    {current:'camera',desired:'camera',phase:'idle',bodyContext:'ceiling'},
    {current:'faceThink',desired:'faceThink',phase:'idle',bodyContext:'ceilingThink'},
  ])for(const paint of [screen=>drawMessage(screen,'New content','Keep this text'),screen=>screen.setSource(new Bitmap()),screen=>screen.draw(()=>{},{animate:true})]){
    const screens={left:surface('left'),right:surface('right')},revisions={},handoff=new ScreenHandoff(screens);
    screens.right.draw(()=>{});const old=screens.right.content;
    const edit=beginScreenEdit(screens,revisions,motion,'left');assert.equal(edit.origin,'right');
    assert.equal(edit.commit(paint),true);assert.notEqual(screens.right.content,old);
    const carried=screens.right.content;handoff.sync('CeilingToLeftPanel');handoff.sync('LeftPanelIdle');
    assert.deepEqual(screens.left.content,carried,'The new content survives the mesh ownership change');
  }
  assert.deepEqual(screenEditPlan({current:'ready',desired:'ready',bodyContext:'ceiling'},'left'),{origin:'left',destination:'left'},'An old remembered context does not redirect unrelated body edits');
});

test('a queued ceiling destination cannot redirect an edit that keeps the current paired layout',()=>{
  for(const motion of [
    {current:'both',arrival:'ready',desired:'ceiling',phase:'exit'},
    {current:'left',arrival:'ready',desired:'ceiling',phase:'exit'},
    {current:'face',arrival:'ceiling',desired:'both',bodyContext:'ceiling',phase:'exit'},
  ]){
    const screens={left:surface('left'),right:surface('right')};screens.right.draw(()=>{});const right=screens.right.content;
    const edit=beginScreenEdit(screens,{},motion,'left');assert.equal(edit.origin,'left');
    edit.commit(screen=>drawMessage(screen,'Only left','Keep right unchanged'));
    assert.equal(screens.right.content,right);
  }
  assert.equal(screenEditPlan({current:'ready',arrival:'ceiling',desired:'ceiling',phase:'enter'},'left').origin,'right','A ceiling entry already in progress still carries the left edit');
});

test('pending uploads cannot replace newer UI edits, API edits, resets, or handoff copies',()=>{
  for(const change of [
    (screens,revisions,motion)=>beginScreenEdit(screens,revisions,motion,'left').commit(screen=>screen.draw(()=>{})),
    screens=>screens.left.draw(()=>{}),
    screens=>screens.left.setSource(new Bitmap()),
    screens=>screens.left.reset(),
    screens=>screens.left.update(),
    screens=>screens.left.copyFrom(screens.right),
  ]){
    const screens={left:surface('left'),right:surface('right')},revisions={},motion={current:'left',desired:'left',phase:'idle'};
    const pending=beginScreenEdit(screens,revisions,motion,'left');change(screens,revisions,motion);
    let applied=false;assert.equal(pending.commit(()=>{applied=true;}),false);assert.equal(applied,false);
  }
  const screens={left:surface('left'),right:surface('right')},pending=beginScreenEdit(screens,{}, {current:'ceiling',desired:'ceiling'},'left');
  screens.right.draw(()=>{});assert.equal(pending.valid(),false,'An API edit on the carried origin also supersedes its pending upload');
  screens.left.setSource(new Canvas());const refresh=beginScreenEdit(screens,{}, {current:'left',desired:'left'},'left');
  screens.left.update();assert.equal(refresh.valid(),false,'An explicit source refresh supersedes an older upload');
});

test('direct canvas update and self-source preserve pixels through resizing and copying',()=>{
  const right=surface('right'),left=surface('left');right.draw(()=>{});
  right.context.fillText('Manual content',10,10);const clears=right.context.clears;
  right.update();assert.equal(right.context.clears,clears,'Updating direct context does not repaint it');
  assert.equal(right.content.kind,'manual');const snapshot=right.content.source;
  assert.equal(snapshot.context.draws[0].source,right.canvas);
  right.setSource(right.canvas);assert.equal(right.context.clears,clears,'Using the output as a source does not clear itself');
  right.setAspect(9.65/6.8);left.copyFrom(right);left.setAspect(5/6);
  assert.notEqual(left.content.source,right.canvas,'The destination owns stable captured pixels');
  assert.ok(Math.abs(right.context.draws.at(-1).args[2]/right.context.draws.at(-1).args[3]-5/6)<1e-10,'Original manually painted proportions are retained');
});

test('HTML images must be decoded before assignment without disturbing existing content',()=>{
  const screen=surface('right');screen.draw(()=>{});const prior=screen.content,image=new Picture();image.naturalWidth=image.naturalHeight=0;
  assert.throws(()=>screen.setSource(image),/Load or decode/);assert.equal(screen.content,prior);
  image.naturalWidth=640;image.naturalHeight=480;assert.doesNotThrow(()=>screen.setSource(image));
});
