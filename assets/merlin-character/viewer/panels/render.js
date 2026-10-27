/* MERLIN panel family — one useful result on the existing white 5:6 screen.
   Inherit the robot's matte blue/cyan world. Big status, quiet context, one action.
   Same painter for the 2D collection, PNG exports, and both 3D screen textures.
   Preview fixtures are synthetic; paintPanel itself never contacts a service. */
export const PANEL_WIDTH = 900;
export const PANEL_HEIGHT = 1080;
export const PANEL_TYPES = Object.freeze([
  {id:'timer',label:'Timer'}, {id:'lights',label:'Lights'}, {id:'oven',label:'Oven'},
  {id:'music',label:'Music'}, {id:'schedule',label:'Schedule set'},
  {id:'routine-saved',label:'Routine set'}, {id:'routine',label:'Your routine'},
]);
export const COLORS = Object.freeze({paper:'#ffffff',ink:'#16334b',muted:'#546d7f',blue:'#246ca7',ice:'#eaf5fc',cyan:'#8bd9f2',line:'#dae7ef',quiet:'#f3f7fa',green:'#27715c',greenBg:'#eaf5f0',amber:'#a65224',amberBg:'#fff0e5'});
const FONT='-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const types = new Set(PANEL_TYPES.map(p=>p.id));
const validStatuses={timer:['running','paused','done','cancelled'],lights:['on','off'],oven:['on','off'],music:['playing','paused','empty'],schedule:['saved','removed'],'routine-saved':['saved'],routine:['ready','running','done']};
function unavailable(s){return !validStatuses[s.type]?.includes(s.status);}
export function createDemoState(type) {
  if(!types.has(type)) throw new TypeError('Unknown panel type.');
  const examples={
    timer:{status:'running',label:'Tea timer',seconds:242,durationSeconds:300},
    lights:{status:'on',label:'Living room'},
    oven:{status:'on',label:'Kitchen oven',temperature:180,unit:'°C',detail:'Heating to 180°C'},
    music:{status:'playing',title:'Slow mornings',artist:'MERLIN sessions',device:'Living room',elapsed:84,duration:218,volume:45},
    schedule:{status:'saved',label:'Lights off',target:'Living room',time:'10:00',period:'PM',repeat:'Every day',timezone:'America/New_York',zoneLabel:'New York'},
    'routine-saved':{status:'saved',label:'Tea time',trigger:'Tea time',artKey:'tea',steps:['Start a 5-minute tea timer']},
    routine:{status:'ready',label:'Tea time',trigger:'Tea time',artKey:'tea',steps:['Start a 5-minute tea timer']},
  };
  return {type,source:'demo',...examples[type]};
}
export async function loadPanelArt(){
  const tea = await new Promise(resolve=>{
    const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>resolve(null);
    img.src=new URL('./art/tea-time.png',import.meta.url).href;
  });
  return {tea};
}
export function formatDuration(value){
  const s=Math.max(0,Math.ceil(Number.isFinite(value)?value:0));
  const hours=Math.floor(s/3600),minutes=Math.floor(s%3600/60),seconds=s%60;
  return hours?`${hours}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`:`${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
}
function rr(c,x,y,w,h,r,fill,stroke){c.beginPath();c.roundRect(x,y,w,h,r);if(fill){c.fillStyle=fill;c.fill();}if(stroke){c.strokeStyle=stroke;c.lineWidth=2;c.stroke();}}
function line(c,x1,y1,x2,y2,color=COLORS.line,width=2){c.beginPath();c.moveTo(x1,y1);c.lineTo(x2,y2);c.strokeStyle=color;c.lineWidth=width;c.stroke();}
function text(c,value,x,y,size=32,{color=COLORS.ink,weight=500,align='left',max=748}={}){
  c.fillStyle=color;c.textAlign=align;c.textBaseline='middle';let fs=size;
  const content=String(value??'');
  do{c.font=`${weight} ${fs}px ${FONT}`;if(c.measureText(content).width<=max||fs<=22)break;fs-=1;}while(fs>22);
  let shown=content;if(c.measureText(shown).width>max){while(shown&&c.measureText(shown+'…').width>max)shown=shown.slice(0,-1);shown+='…';}
  c.fillText(shown,x,y);return shown;
}
function center(c,value,y,size,options={}){return text(c,value,450,y,size,{align:'center',...options});}
function icon(c,name,x,y,size,color=COLORS.blue){
  c.save();c.translate(x,y);c.scale(size/48,size/48);c.strokeStyle=color;c.fillStyle=color;c.lineWidth=2.6;c.lineCap='round';c.lineJoin='round';
  const path=points=>{c.beginPath();points.forEach(([a,b],i)=>i?c.lineTo(a,b):c.moveTo(a,b));c.stroke();};
  const circle=(a,b,r)=>{c.beginPath();c.arc(a,b,r,0,Math.PI*2);c.stroke();};
  if(name==='timer'){circle(24,27,16);path([[18,3],[30,3]]);path([[24,3],[24,8]]);path([[37,11],[41,7]]);path([[24,17],[24,27],[31,27]]);}
  if(name==='bulb'){c.beginPath();c.moveTo(17,32);c.bezierCurveTo(17,27,10,25,10,17);c.arc(24,17,14,Math.PI,0);c.bezierCurveTo(38,25,31,27,31,32);c.closePath();c.stroke();path([[17,37],[31,37]]);path([[21,43],[27,43]]);}
  if(name==='oven'){rr(c,4,4,40,40,5,null,color);path([[4,14],[44,14]]);rr(c,11,21,26,16,2,null,color);circle(12,9,1);circle(20,9,1);path([[28,9],[36,9]]);}
  if(name==='music'){path([[18,33],[18,10],[38,5],[38,28]]);path([[18,16],[38,11]]);c.beginPath();c.ellipse(12,35,6,4,0,0,7);c.fill();c.beginPath();c.ellipse(32,30,6,4,0,0,7);c.fill();}
  if(name==='calendar'){rr(c,5,8,38,36,5,null,color);path([[5,19],[43,19]]);path([[15,3],[15,13]]);path([[33,3],[33,13]]);path([[16,31],[22,37],[33,26]]);}
  if(name==='check')path([[10,24],[20,34],[39,14]]);
  if(name==='power'){c.beginPath();c.arc(24,27,16,-Math.PI*.32,Math.PI*1.32);c.stroke();path([[24,4],[24,24]]);}
  if(name==='play'){c.beginPath();c.moveTo(17,11);c.lineTo(37,24);c.lineTo(17,37);c.closePath();c.fill();}
  if(name==='pause'){rr(c,14,10,7,28,2,color);rr(c,28,10,7,28,2,color);}
  if(name==='next'){c.beginPath();c.moveTo(12,12);c.lineTo(31,24);c.lineTo(12,36);c.closePath();c.fill();path([[35,12],[35,36]]);}
  if(name==='cup'){path([[7,16],[35,16],[33,36],[29,40],[13,40],[9,36],[7,16]]);c.beginPath();c.arc(36,24,7,-Math.PI/2,Math.PI/2);c.stroke();path([[5,45],[37,45]]);path([[16,4],[16,9]]);path([[25,2],[25,9]]);}
  if(name==='spark'){path([[24,3],[29,18],[44,24],[29,30],[24,45],[19,30],[4,24],[19,18],[24,3]]);}
  if(name==='alert'){circle(24,24,19);path([[24,13],[24,27]]);circle(24,34,1);}
  c.restore();
}
function header(c,label,name){icon(c,name,76,74,43);text(c,label,138,96,32,{weight:600});}
function footer(c,caption='MERLIN'){
  line(c,76,975,824,975);text(c,caption,76,1016,25,{color:COLORS.muted});
  rr(c,778,1001,9,25,4,COLORS.cyan);rr(c,798,996,9,35,4,COLORS.blue);rr(c,818,1001,9,25,4,COLORS.cyan);
}
function badge(c,label,y,color=COLORS.green,bg=COLORS.greenBg){
  c.font=`600 28px ${FONT}`;const w=Math.min(700,c.measureText(label).width+70);rr(c,450-w/2,y-26,w,52,26,bg);center(c,label,y,28,{color,weight:600,max:w-35});
}
function primary(c,label,{x=76,y=839,w=748,h=90,disabled=false}={}){rr(c,x,y,w,h,24,disabled?COLORS.quiet:COLORS.blue);text(c,label,x+w/2,y+h/2,31,{align:'center',color:disabled?COLORS.muted:COLORS.paper,weight:600,max:w-40});}
function art(c,source,x,y,size){
  rr(c,x,y,size,size,40,COLORS.quiet);c.save();c.beginPath();c.roundRect(x,y,size,size,40);c.clip();
  if(source){const iw=source.naturalWidth||source.width,ih=source.naturalHeight||source.height;const scale=Math.max(size/iw,size/ih);c.drawImage(source,x+(size-iw*scale)/2,y+(size-ih*scale)/2,iw*scale,ih*scale);}
  else icon(c,'spark',x+size*.25,y+size*.25,size*.5);
  c.restore();
}
export function panelActions(s){
  if(!s||!types.has(s.type))return [];
  if(unavailable(s))return [];
  if(s.type==='timer')return ['done','cancelled'].includes(s.status)?[{id:'restart',label:'Start again',x:76,y:839,w:748,h:90}]:[{id:'toggle',label:s.status==='paused'?'Resume timer':'Pause timer',x:76,y:839,w:532,h:90},{id:'cancel',label:'Cancel timer',x:632,y:839,w:192,h:90}];
  if(s.type==='lights'||s.type==='oven')return [{id:'toggle',label:s.status==='on'?'Turn off':'Turn on',x:76,y:839,w:748,h:90}];
  if(s.type==='music'&&s.status!=='empty')return [{id:'previous',label:'Previous track',x:236,y:708,w:100,h:100},{id:'toggle',label:s.status==='playing'?'Pause music':'Play music',x:390,y:698,w:120,h:120},{id:'next',label:'Next track',x:564,y:708,w:100,h:100}];
  if(s.type==='schedule'&&s.status==='saved')return [{id:'remove',label:'Remove schedule',x:76,y:839,w:748,h:90}];
  if(s.type==='routine-saved')return [{id:'view',label:'View routine',x:76,y:839,w:748,h:90}];
  if(s.type==='routine'&&s.status!=='running')return [{id:'run',label:s.status==='done'?'Run again':'Run routine',x:76,y:839,w:748,h:90}];
  return [];
}
export function panelDescription(s){
  if(unavailable(s))return `${s.label||s.title||'Panel'}. ${s.status==='pending'?'Waiting for confirmation':s.status==='offline'?'Not connected':s.status==='error'?'Couldn’t finish. Please try again':'State unknown. Waiting for a device update'}.`;
  switch(s.type){
    case 'timer':return `${s.label}. ${formatDuration(s.seconds)} remaining. ${s.status}.`;
    case 'lights':case 'oven':return `${s.label}. ${s.status}.${s.status==='on'&&s.detail?' '+s.detail:''}`;
    case 'music':if(s.status==='empty')return 'Nothing playing. Choose something you love.';return `${s.status}. ${s.title||'No track selected'}${s.artist?' by '+s.artist:''}.`;
    case 'schedule':return `${s.status==='saved'?'Schedule set':s.status}. ${s.label}, ${s.target}, ${s.time} ${s.period}, ${s.repeat}, ${s.timezone}.`;
    default:return `${s.label}. ${s.status==='saved'?'Routine saved':s.status}. ${(Array.isArray(s.steps)?s.steps:[]).join('. ')}.`;
  }
}
export function paintPanel(c,width,height,s,{art:images={},controls=true}={}){
  if(!s||!types.has(s.type))throw new TypeError('A valid panel type is required.');
  c.save();c.scale(width/900,height/1080);c.fillStyle=COLORS.paper;c.fillRect(0,0,900,1080);c.lineCap='round';c.lineJoin='round';
  const blocked=unavailable(s);
  const title={timer:['Timer','timer'],lights:['Lights','bulb'],oven:['Oven','oven'],music:['Music','music'],schedule:['Schedule','calendar'],'routine-saved':['Routine','spark'],routine:['Routine','spark']}[s.type];
  header(c,...title);
  if(blocked){
    icon(c,s.status==='pending'?title[1]:'alert',362,310,176,COLORS.muted);
    center(c,s.status==='pending'?'One moment…':s.status==='offline'?'Not connected':s.status==='error'?'Couldn’t finish':'State unknown',566,60,{weight:600});
    center(c,s.label||s.title||title[0],654,36,{color:COLORS.muted});
    center(c,s.status==='pending'?'Waiting for confirmation':s.status==='offline'?'Check the device connection':s.status==='error'?'Please try again':'Waiting for a device update',720,30,{color:COLORS.muted});
    footer(c);c.restore();return;
  }
  if(s.type==='timer'){
    const done=s.status==='done',cancelled=s.status==='cancelled',paused=s.status==='paused';
    center(c,s.label||'Timer',222,43,{weight:600});
    c.beginPath();c.arc(450,496,187,0,2*Math.PI);c.strokeStyle=COLORS.ice;c.lineWidth=15;c.stroke();
    const fraction=Math.max(0,Math.min(1,(s.seconds||0)/(s.durationSeconds||1)));
    c.beginPath();c.arc(450,496,187,-Math.PI/2,-Math.PI/2+2*Math.PI*(done?1:fraction));c.strokeStyle=paused?COLORS.muted:done?COLORS.green:COLORS.blue;c.stroke();
    center(c,done?'All done':cancelled?'Cancelled':formatDuration(s.seconds),492,done||cancelled?70:112,{weight:550,max:340});
    center(c,done?'Your timer is up':cancelled?'Timer stopped':paused?'Paused':'remaining',572,29,{color:COLORS.muted});
    center(c,`${formatDuration(s.durationSeconds)} timer`,748,30,{color:COLORS.muted});
    if(controls){if(done||cancelled)primary(c,'Start again');
    else{primary(c,paused?'Resume':'Pause',{w:532});rr(c,632,839,192,90,24,COLORS.quiet);text(c,'Cancel',728,884,30,{align:'center',color:COLORS.muted});}}
  }
  if(s.type==='lights'||s.type==='oven'){
    const on=s.status==='on',isOven=s.type==='oven';
    center(c,s.label||title[0],224,45,{weight:600});
    rr(c,300,307,300,300,100,on?(isOven?COLORS.amberBg:COLORS.ice):COLORS.quiet);
    icon(c,isOven?'oven':'bulb',358,365,184,on?(isOven?COLORS.amber:COLORS.blue):COLORS.muted);
    center(c,on?'On':'Off',685,90,{weight:550});
    center(c,isOven?(on?(s.detail||'Oven is on'):'Oven is off'):(on?'A little brighter.':'Lights are off.'),765,31,{color:COLORS.muted});
    if(controls)primary(c,on?'Turn off':'Turn on');
  }
  if(s.type==='music'){
    if(s.status==='empty'){
      icon(c,'music',360,300,180,COLORS.muted);center(c,'Nothing playing',594,58,{weight:600});center(c,'Choose something you love.',670,32,{color:COLORS.muted});
    }else{
      rr(c,254,177,392,344,40,COLORS.ice);
      c.beginPath();c.arc(450,349,137,0,7);c.fillStyle=COLORS.ink;c.fill();
      [97,112,126].forEach(r=>{c.beginPath();c.arc(450,349,r,0,7);c.strokeStyle='#38546a';c.lineWidth=2;c.stroke();});
      c.beginPath();c.arc(450,349,48,0,7);c.fillStyle=COLORS.cyan;c.fill();c.beginPath();c.arc(450,349,9,0,7);c.fillStyle=COLORS.paper;c.fill();
      center(c,s.title||'Unknown track',571,49,{weight:600,max:730});center(c,s.artist||'Unknown artist',626,29,{color:COLORS.muted});
      if(controls){c.save();c.translate(336,708);c.scale(-1,1);icon(c,'next',0,0,100,COLORS.ink);c.restore();
      rr(c,390,698,120,120,60,COLORS.blue);icon(c,s.status==='playing'?'pause':'play',424,732,52,COLORS.paper);icon(c,'next',564,708,100,COLORS.ink);}
      line(c,100,865,800,865,COLORS.line,6);line(c,100,865,100+700*Math.max(0,Math.min(1,(s.elapsed||0)/(s.duration||1))),865,COLORS.blue,6);
      text(c,formatDuration(s.elapsed),100,903,25,{color:COLORS.muted});text(c,formatDuration(s.duration),800,903,25,{align:'right',color:COLORS.muted});
    }
  }
  if(s.type==='schedule'){
    const removed=s.status==='removed';
    rr(c,378,187,144,144,72,removed?COLORS.quiet:COLORS.greenBg);icon(c,removed?'calendar':'check',416,225,68,removed?COLORS.muted:COLORS.green);
    center(c,removed?'Schedule removed':'Schedule set',391,55,{weight:600});
    center(c,`${s.time||'—'} ${s.period||''}`.trim(),517,101,{weight:550});
    badge(c,s.repeat||'One time',605,COLORS.blue,COLORS.ice);
    center(c,s.label||'Scheduled action',705,40,{weight:600});center(c,s.target||'',756,30,{color:COLORS.muted});
    if(controls&&!removed){rr(c,76,839,748,90,24,COLORS.quiet);center(c,'Remove schedule',884,30,{color:COLORS.muted});}
  }
  if(s.type==='routine'||s.type==='routine-saved'){
    const saved=s.type==='routine-saved',done=s.status==='done',running=s.status==='running';
    art(c,images[s.artKey],285,178,330);
    if(saved){rr(c,562,444,72,72,36,COLORS.greenBg);icon(c,'check',576,458,44,COLORS.green);}
    center(c,s.label||'Your routine',565,61,{weight:600});
    center(c,saved?'Routine saved':done?'All done':running?'Running…':`Say “${s.trigger||s.label||'your phrase'}”`,627,31,{color:saved||done?COLORS.green:COLORS.muted});
    const steps=Array.isArray(s.steps)?s.steps:[];
    const displayed=steps.slice(0,2);
    displayed.forEach((step,i)=>{const y=714+i*62;if(done)icon(c,'check',96,y-19,37,COLORS.green);else{rr(c,96,y-18,36,36,18,COLORS.ice);text(c,String(i+1),114,y,24,{align:'center',color:COLORS.blue});}text(c,step,154,y,31,{max:630});});
    if(steps.length>2)text(c,`+ ${steps.length-2} more actions`,154,805,25,{color:COLORS.muted});
    if(controls)primary(c,saved?'View routine':done?'Run again':running?'Running…':'Run routine',{disabled:running});
  }
  const foot=s.type==='music'?`${s.status==='playing'?'Playing':s.status==='paused'?'Paused':'Music'}${s.device?' · '+s.device:''}`:s.type==='schedule'?(s.zoneLabel||s.timezone||'Time zone required'):'MERLIN';
  footer(c,foot);c.restore();
}
