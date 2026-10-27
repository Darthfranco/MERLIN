import * as THREE from './vendor/three/build/three.module.min.js';

export class ScreenSurface {
  constructor(id,materials,width=900,height=1080){
    this.id=id;this.materials=materials;this.canvas=document.createElement('canvas');
    this.canvas.width=width;this.canvas.height=height;this.context=this.canvas.getContext('2d');
    this.texture=null;this.animate=null;this.source=null;this.autoUpdate=false;
    this.originals=materials.map(m=>({map:m.map,emissiveMap:m.emissiveMap,color:m.color.clone(),emissive:m.emissive.clone(),strength:m.emissiveIntensity}));
  }
  setSource(source,{autoUpdate=source instanceof HTMLCanvasElement}={}){
    if(!(source instanceof HTMLCanvasElement||source instanceof HTMLImageElement||source instanceof HTMLVideoElement||source instanceof ImageBitmap))throw new TypeError('Use a canvas, image, ImageBitmap, or video element.');
    this.animate=null;
    if(this.texture)this.texture.dispose();
    this.source=source;this.autoUpdate=autoUpdate;
    this.texture=source instanceof HTMLVideoElement?new THREE.VideoTexture(source):new THREE.CanvasTexture(source);
    this.texture.flipY=false;this.texture.colorSpace=THREE.SRGBColorSpace;
    this.texture.anisotropy=4;
    for(const mat of this.materials){mat.map=this.texture;mat.emissiveMap=this.texture;mat.needsUpdate=true;}
    return this;
  }
  draw(painter,{animate=false}={}){
    if(typeof painter!=='function')throw new TypeError('Pass a function that draws on a 2D canvas.');
    this.setSource(this.canvas,{autoUpdate:false});
    const paint=time=>{this.context.save();try{painter(this.context,this.canvas.width,this.canvas.height,time);}finally{this.context.restore();}this.texture.needsUpdate=true;};
    paint(0);this.animate=animate?paint:null;return this;
  }
  update(){if(this.texture)this.texture.needsUpdate=true;}
  tick(seconds){if(this.animate)this.animate(seconds);else if(this.autoUpdate)this.update();}
  reset(){
    this.animate=null;this.source=null;if(this.texture)this.texture.dispose();this.texture=null;
    this.materials.forEach((mat,i)=>{const old=this.originals[i];mat.map=old.map;mat.emissiveMap=old.emissiveMap;mat.color.copy(old.color);mat.emissive.copy(old.emissive);mat.emissiveIntensity=old.strength;mat.needsUpdate=true;});
  }
}

export function collectScreens(root){
  const groups={};
  root.traverse(obj=>{
    if(!obj.isMesh)return;
    for(const mat of Array.isArray(obj.material)?obj.material:[obj.material]){
      const id=mat.userData.merlin_screen_id||(/^MERLIN_Screen_(right|left|camera)$/.exec(mat.name)||[])[1];
      if(id){(groups[id]??=new Set()).add(mat);}
    }
  });
  return Object.fromEntries(Object.entries(groups).map(([id,set])=>[id,new ScreenSurface(id,[...set],id==='camera'?1280:900,id==='camera'?720:1080)]));
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
