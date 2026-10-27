import * as THREE from './vendor/three/build/three.module.min.js';

function snapshotPixels(source){
  const width=source.naturalWidth||source.width,height=source.naturalHeight||source.height;
  if(!width||!height)throw new TypeError('Load or decode the image before assigning it to a screen.');
  const copy=document.createElement('canvas');copy.width=width;copy.height=height;
  copy.getContext('2d').drawImage(source,0,0);return copy;
}

export class ScreenSurface {
  constructor(id,materials,width=900,height=1080){
    this.id=id;this.materials=materials;this.canvas=document.createElement('canvas');
    this.canvas.width=width;this.canvas.height=height;this.context=this.canvas.getContext('2d');
    this.width=width;this.height=height;this.aspect=width/height;this.content=null;
    this.texture=null;this.animate=null;this.source=null;this.autoUpdate=false;this.time=0;this.version=0;
    this.originals=materials.map(m=>({map:m.map,emissiveMap:m.emissiveMap,color:m.color.clone(),emissive:m.emissive.clone(),strength:m.emissiveIntensity}));
  }
  attach(){
    if(!this.texture){this.texture=new THREE.CanvasTexture(this.canvas);this.texture.flipY=false;this.texture.colorSpace=THREE.SRGBColorSpace;this.texture.anisotropy=4;}
    for(const mat of this.materials)if(mat.map!==this.texture||mat.emissiveMap!==this.texture){mat.map=this.texture;mat.emissiveMap=this.texture;mat.needsUpdate=true;}
  }
  setSource(source,{autoUpdate=source instanceof HTMLCanvasElement||source instanceof HTMLVideoElement}={}){
    if(!(source instanceof HTMLCanvasElement||source instanceof HTMLImageElement||source instanceof HTMLVideoElement||source instanceof ImageBitmap))throw new TypeError('Use a canvas, image, ImageBitmap, or video element.');
    if(source instanceof HTMLImageElement&&(!source.naturalWidth||!source.naturalHeight))throw new TypeError('Load or decode the image before assigning it to a screen.');
    if(source===this.canvas)return this.captureCanvas();
    // Own immutable image pixels before a caller closes its ImageBitmap. Canvas
    // and video sources stay live, including after a panel-to-panel handoff.
    if(source instanceof ImageBitmap||(source instanceof HTMLImageElement&&!autoUpdate)){
      source=snapshotPixels(source);autoUpdate=false;
    }
    this.version++;this.content={kind:'source',source,autoUpdate};this.source=source;this.autoUpdate=autoUpdate;this.animate=null;
    this.paintCanvas=null;this.attach();this.render(this.time);return this;
  }
  draw(painter,{animate=false,reflow=true}={}){
    if(typeof painter!=='function')throw new TypeError('Pass a function that draws on a 2D canvas.');
    this.version++;this.content={kind:'painter',painter,animate,reflow,width:this.width,height:this.height};
    this.source=this.canvas;this.autoUpdate=false;this.animate=animate?seconds=>this.render(seconds):null;
    this.paintCanvas=null;this.attach();this.render(this.time);return this;
  }
  copyFrom(other){
    if(!(other instanceof ScreenSurface))throw new TypeError('Copy content from another screen surface.');
    this.version++;this.content=other.content?{...other.content}:{kind:'source',source:other.originalImage(),autoUpdate:false};
    this.source=this.content.kind==='source'?this.content.source:this.canvas;
    this.autoUpdate=!!this.content.autoUpdate;this.animate=this.content.animate?seconds=>this.render(seconds):null;
    this.paintCanvas=null;this.attach();this.render(other.time);return this;
  }
  originalImage(){return this.originals[0]?.map?.image||this.originals[0]?.emissiveMap?.image;}
  captureCanvas(){
    // A caller can paint directly on context and then call update(). Keep those
    // pixels before a later resize/handoff needs to composite them again.
    this.version++;this.content={kind:'manual',source:snapshotPixels(this.canvas),aspect:this.aspect,autoUpdate:false};
    this.source=this.canvas;this.autoUpdate=false;this.animate=null;this.paintCanvas=null;
    this.attach();this.texture.needsUpdate=true;return this;
  }
  setAspect(aspect){
    if(!Number.isFinite(aspect)||aspect<=0)return false;
    if(Math.abs(aspect-this.aspect)<.002)return false;
    this.aspect=aspect;this.attach();this.render(this.time);return true;
  }
  render(seconds=0){
    this.time=seconds;const content=this.content||{kind:'source',source:this.originalImage()};
    const ctx=this.context,w=this.height*this.aspect,h=this.height;
    ctx.save();ctx.setTransform(this.canvas.width/w,0,0,this.canvas.height/h,0,0);
    ctx.clearRect(0,0,w,h);ctx.fillStyle='#ffffff';ctx.fillRect(0,0,w,h);
    try{
      if(content.kind==='painter'&&content.reflow)content.painter(ctx,w,h,seconds);
      else {
        let source=content.source;
        if(content.kind==='painter'){
          if(!this.paintCanvas){this.paintCanvas=document.createElement('canvas');this.paintCanvas.width=content.width;this.paintCanvas.height=content.height;}
          const pc=this.paintCanvas.getContext('2d');pc.save();try{content.painter(pc,content.width,content.height,seconds);}finally{pc.restore();}
          source=this.paintCanvas;
        }
        const sw=source?.videoWidth||source?.naturalWidth||source?.width,sh=source?.videoHeight||source?.naturalHeight||source?.height;
        if(sw&&sh&&(!(source instanceof HTMLVideoElement)||source.readyState>=2)){
          const ratio=content.aspect||sw/sh,dw=Math.min(w,h*ratio),dh=dw/ratio;
          ctx.drawImage(source,(w-dw)/2,(h-dh)/2,dw,dh);
        }
      }
    }finally{ctx.restore();}
    if(this.texture)this.texture.needsUpdate=true;
  }
  update(){
    if(this.content?.kind==='source'){this.version++;this.render(this.time);return;}
    if(this.content?.animate){this.version++;if(this.texture)this.texture.needsUpdate=true;return;}
    this.captureCanvas();
  }
  tick(seconds){if(this.animate)this.animate(seconds);else if(this.autoUpdate)this.render(seconds);}
  reset(){
    this.version++;this.content=null;this.animate=null;this.source=null;this.autoUpdate=false;this.paintCanvas=null;
    if(this.texture)this.texture.dispose();this.texture=null;
    this.materials.forEach((mat,i)=>{const old=this.originals[i];mat.map=old.map;mat.emissiveMap=old.emissiveMap;mat.color.copy(old.color);mat.emissive.copy(old.emissive);mat.emissiveIntensity=old.strength;mat.needsUpdate=true;});
    if(Math.abs(this.aspect-this.width/this.height)>.002){this.attach();this.render(this.time);}
  }
}

/** Derive screen dimensions from its UV plane, including animated nonuniform scale. */
export function surfaceBasis(mesh){
  const positions=mesh.geometry.attributes.position,uv=mesh.geometry.attributes.uv,index=mesh.geometry.index;
  if(!uv)return null;
  for(let i=0;i<(index?.count||positions.count)-2;i+=3){
    const ids=[0,1,2].map(j=>index?index.getX(i+j):i+j);
    const p=ids.map(id=>new THREE.Vector3().fromBufferAttribute(positions,id)),t=ids.map(id=>new THREE.Vector2().fromBufferAttribute(uv,id));
    const a=p[1].sub(p[0]),b=p[2].sub(p[0]),u=t[1].sub(t[0]),v=t[2].sub(t[0]),det=u.x*v.y-u.y*v.x;
    if(Math.abs(det)<1e-8)continue;
    return {mesh,u:a.clone().multiplyScalar(v.y).addScaledVector(b,-u.y).divideScalar(det),v:b.multiplyScalar(u.x).addScaledVector(a,-v.x).divideScalar(det)};
  }
  return null;
}

export function syncScreenAspect(screen){
  const basis=screen.basis;if(!basis)return;
  basis.mesh.updateWorldMatrix(true,false);const matrix=new THREE.Matrix3().setFromMatrix4(basis.mesh.matrixWorld);
  const w=basis.u.clone().applyMatrix3(matrix).length(),h=basis.v.clone().applyMatrix3(matrix).length();
  if(w>1e-5&&h>1e-5)screen.setAspect(w/h);
}

export function collectScreens(root){
  const groups={},surfaces={};
  root.traverse(obj=>{
    if(!obj.isMesh)return;
    for(const mat of Array.isArray(obj.material)?obj.material:[obj.material]){
      const id=mat.userData.merlin_screen_id||(/^MERLIN_Screen_(right|left|camera)$/.exec(mat.name)||[])[1];
      if(id){
        (groups[id]??=new Set()).add(mat);
        let owner=obj;while(owner&&!owner.userData.merlin_screen_role)owner=owner.parent;
        if(owner?.userData.merlin_screen_role==='surface'&&!surfaces[id])surfaces[id]=surfaceBasis(obj);
      }
    }
  });
  return Object.fromEntries(Object.entries(groups).map(([id,set])=>{const screen=new ScreenSurface(id,[...set],id==='camera'?1280:900,id==='camera'?720:1080);screen.basis=surfaces[id];return [id,screen];}));
}

function linesFor(ctx,text,width){
  const lines=[];
  for(const paragraph of text.split('\n')){
    let line='';
    for(const word of paragraph.split(/\s+/)){
      if(line&&ctx.measureText(line+' '+word).width>width){lines.push(line);line='';}
      for(const letter of (line?' ':'')+word){
        if(line&&ctx.measureText(line+letter).width>width){lines.push(line);line='';}
        line+=letter;
      }
    }
    lines.push(line);
  }
  return lines;
}
function fitted(ctx,text,x,y,width,height,size,weight='400'){
  let lines,lineHeight;
  do{ctx.font=weight+' '+size+'px -apple-system, sans-serif';lines=linesFor(ctx,text,width);lineHeight=size*1.4;if(lines.length*lineHeight<=height||size<=12)break;size--; }while(size>0);
  ctx.save();ctx.beginPath();ctx.rect(x,y-size,width,height+size);ctx.clip();
  lines.forEach((line,i)=>ctx.fillText(line,x,y+i*lineHeight));ctx.restore();
  return y+lines.length*lineHeight;
}

export function drawMessage(screen,title,body){
  screen.draw((ctx,w,h)=>{
    ctx.fillStyle='#ffffff';ctx.fillRect(0,0,w,h);
    const pad=Math.round(w*.09);ctx.fillStyle='#185c9e';ctx.fillRect(pad,h*.12,w*.12,7);
    ctx.fillStyle='#172a3b';
    const y=fitted(ctx,title,pad,h*.24,w-2*pad,h*.26,Math.round(w*.065),'600');
    ctx.fillStyle='#4e6070';
    fitted(ctx,body,pad,y+w*.025,w-2*pad,Math.max(80,h*.87-y-w*.025),Math.round(w*.039));
    ctx.fillStyle='#185c9e';ctx.font='500 '+Math.round(w*.022)+'px -apple-system, sans-serif';ctx.fillText('MERLIN',pad,h-pad*.7);
  });
}

export function drawCanvasDemo(screen){
  screen.draw((ctx,w,h,t)=>{
    ctx.fillStyle='#ffffff';ctx.fillRect(0,0,w,h);ctx.fillStyle='#172a3b';ctx.font='600 '+Math.round(w*.065)+'px sans-serif';ctx.fillText('Make it yours.',w*.09,h*.19);
    ctx.fillStyle='#4e6070';ctx.font=Math.round(w*.035)+'px sans-serif';ctx.fillText('A live canvas, drawn by code.',w*.09,h*.27);
    for(let i=0;i<7;i++){
      const barh=h*(.1+.19*(.5+.5*Math.sin(t*2-i*.7)));
      ctx.fillStyle=i===3?'#185c9e':'#78d9ed';ctx.beginPath();ctx.roundRect(w*(.12+i*.108),h*.68-barh/2,w*.065,barh,w*.0325);ctx.fill();
    }
    ctx.fillStyle='#4e6070';ctx.font=Math.round(w*.025)+'px sans-serif';ctx.fillText('Synthetic animation · no audio input',w*.09,h*.9);
  },{animate:true});
}
