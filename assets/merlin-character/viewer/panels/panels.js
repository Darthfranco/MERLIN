import {PANEL_TYPES,createDemoState,paintPanel,loadPanelArt,panelActions,panelDescription} from './render.js';
const $=id=>document.getElementById(id);
const descriptions={timer:'A clear countdown, with just pause and cancel.',lights:'One room. One state. One switch.',oven:'The oven’s state, clear and simple.',music:'Your music, with room to breathe.',schedule:'What will happen, when, and how often.','routine-saved':'A quiet confirmation. Saving never starts the routine.',routine:'A familiar picture for your own little ritual.'};
const variants={timer:[['running','Counting down'],['paused','Paused'],['done','Finished'],['cancelled','Cancelled']],lights:[['on','On'],['off','Off'],['pending','Waiting for device'],['offline','Not connected'],['error','Action failed']],oven:[['on','On'],['off','Off'],['pending','Waiting for device'],['offline','Not connected'],['error','Action failed']],music:[['playing','Playing'],['paused','Paused'],['empty','Nothing playing'],['offline','Not connected']],schedule:[['saved','Saved'],['removed','Removed'],['error','Save failed']],'routine-saved':[['saved','Saved'],['error','Save failed']],routine:[['ready','Ready'],['running','Running'],['done','Complete'],['error','Action failed']]};
let images={},state=null,timerDeadline=null,routineRun=null;
const drawings=[];
const artPromise=loadPanelArt();
for(const p of PANEL_TYPES){
  const tile=document.createElement('article');tile.className='panel-tile';
  const open=document.createElement('button');open.type='button';open.className='panel-open';open.id=`open-${p.id}`;open.setAttribute('aria-label',`Preview ${p.label.toLowerCase()} panel`);
  const canvas=document.createElement('canvas');canvas.width=900;canvas.height=1080;canvas.setAttribute('aria-hidden','true');
  const caption=document.createElement('div');caption.className='tile-caption';const title=document.createElement('strong');title.textContent=p.label;const action=document.createElement('span');action.textContent='Try panel ↗';caption.append(title,action);
  const subtitle=document.createElement('p');subtitle.className='tile-subtitle';subtitle.textContent={timer:'Time for a little tea.',lights:'On, off. That’s it.',oven:'Know where things stand.',music:'A moment for your music.',schedule:'All set for later.','routine-saved':'Remembered for next time.',routine:'Made yours.'}[p.id];
  open.append(canvas,caption);tile.append(open,subtitle);$('panel-grid').append(tile);
  const demo=createDemoState(p.id);paintPanel(canvas.getContext('2d'),900,1080,demo,{art:images});drawings.push({canvas,state:demo});open.addEventListener('click',()=>show(p.id));
}
artPromise.then(art=>{images=art;if(!art.tea)$('load-error').hidden=false;drawings.forEach(d=>paintPanel(d.canvas.getContext('2d'),900,1080,d.state,{art:images}));if(state)draw();});
function clearRun(){if(routineRun)clearTimeout(routineRun);routineRun=null;timerDeadline=null;}
function show(type,{push=true}={}){
  clearRun();state=createDemoState(type);$('collection').hidden=true;$('detail').hidden=false;
  const label=PANEL_TYPES.find(p=>p.id===type).label;$('detail-title').textContent=label;$('detail-description').textContent=descriptions[type];
  $('variant').replaceChildren(...variants[type].map(([value,label])=>new Option(label,value)));
  $('variant').value=state.status;$('panel-name').value=state.label||state.title||'';
  $('timer-field').hidden=type!=='timer';$('timer-minutes').value=5;$('repeat-field').hidden=type!=='schedule';$('repeat').value='Every day';$('art-note').hidden=!type.startsWith('routine');
  $('feedback').textContent='';$('on-robot').href=`../?panel=${type}&side=right`;
  if(type==='timer')state.status='paused'; // Explicitly start the interactive countdown; overview shows running.
  $('variant').value=state.status;
  if(push)history.pushState({},'',`?panel=${type}`);draw();window.scrollTo({top:0});if(push)$('detail-title').focus({preventScroll:true});
}
function draw(){
  if(!state)return;const canvas=$('detail-canvas');paintPanel(canvas.getContext('2d'),900,1080,state,{art:images});canvas.setAttribute('aria-label',panelDescription(state));
  const actions=panelActions(state);const key=actions.map(a=>a.id+':'+a.label).join('|');
  if($('touch-controls').dataset.actions!==key){
    const focused=document.activeElement?.dataset?.action;
    $('touch-controls').replaceChildren(...actions.map(a=>{
      const button=document.createElement('button');button.type='button';button.className='touch-action';button.dataset.action=a.id;button.setAttribute('aria-label',a.label);button.title=a.label;
      Object.assign(button.style,{left:`${a.x/9}%`,top:`${a.y/10.8}%`,width:`${a.w/9}%`,height:`${a.h/10.8}%`});button.addEventListener('click',()=>act(a.id));return button;
    }));$('touch-controls').dataset.actions=key;
    if(focused)$('touch-controls').querySelector(`[data-action="${focused}"]`)?.focus({preventScroll:true});
  }
  $('variant').value=state.status;
}
function act(action){
  $('feedback').textContent='';
  if(state.type==='timer'){
    if(action==='toggle'){state.status=state.status==='paused'?'running':'paused';timerDeadline=state.status==='running'?Date.now()+state.seconds*1000:null;}
    if(action==='cancel'){state.status='cancelled';timerDeadline=null;}
    if(action==='restart'){state.seconds=state.durationSeconds;state.status='running';timerDeadline=Date.now()+state.seconds*1000;}
  }else if(state.type==='lights'||state.type==='oven'){state.status=state.status==='on'?'off':'on';$('feedback').textContent='Preview state changed. No device command was sent.';}
  else if(state.type==='music'){
    if(action==='toggle')state.status=state.status==='playing'?'paused':'playing';
    else{state.title=state.title==='Slow mornings'?'Blue hour':'Slow mornings';state.elapsed=0;$('panel-name').value=state.title;}
    $('feedback').textContent='Playback preview only. No audio is playing.';
  }else if(state.type==='schedule'){state.status='removed';$('feedback').textContent='Removed from this preview only.';}
  else if(state.type==='routine-saved'){const name=state.label,steps=state.steps;show('routine');state.label=name;state.steps=steps;state.trigger=name;$('panel-name').value=name;}
  else if(state.type==='routine'){
    state.status='running';const active=state;routineRun=setTimeout(()=>{if(state!==active)return;state.status='done';$('feedback').textContent='Preview complete. No real timer was started.';draw();},1100);
  }
  draw();
}
$('variant').addEventListener('change',()=>{clearRun();state.status=$('variant').value;if(state.type==='timer'&&state.status==='running')timerDeadline=Date.now()+state.seconds*1000;if(state.status==='done'&&state.type==='timer')state.seconds=0;$('feedback').textContent='Preview state changed.';draw();});
$('panel-name').addEventListener('input',()=>{state[state.type==='music'?'title':'label']=$('panel-name').value;if(state.type.startsWith('routine'))state.trigger=$('panel-name').value;draw();});
$('timer-minutes').addEventListener('change',()=>{const minutes=Number($('timer-minutes').value);if(!Number.isInteger(minutes)||minutes<1||minutes>10080){$('feedback').textContent='Choose a whole number from 1 to 10,080 minutes.';return;}state.seconds=state.durationSeconds=minutes*60;state.status='paused';timerDeadline=null;draw();});
$('repeat').addEventListener('change',()=>{state.repeat=$('repeat').value;draw();});
function back({push=true}={}){const previousType=state?.type;clearRun();state=null;$('detail').hidden=true;$('collection').hidden=false;if(push)history.pushState({},'','./');window.scrollTo({top:0});if(push&&previousType)$(`open-${previousType}`)?.focus({preventScroll:true});}
$('back').addEventListener('click',()=>back());
window.addEventListener('popstate',()=>route());
function route(){const type=new URLSearchParams(location.search).get('panel');if(PANEL_TYPES.some(p=>p.id===type))show(type,{push:false});else back({push:false});}
$('download').addEventListener('click',()=>{
  const filename=`merlin-${state.type}-${state.status}.png`;const exportCanvas=document.createElement('canvas');exportCanvas.width=900;exportCanvas.height=1080;paintPanel(exportCanvas.getContext('2d'),900,1080,state,{art:images});
  exportCanvas.toBlob(blob=>{if(!blob){$('feedback').textContent='Couldn’t export. Try again.';return;}const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$('feedback').textContent='Panel exported at 900 × 1080.';},'image/png');
});
setInterval(()=>{if(!state||state.type!=='timer'||state.status!=='running'||!timerDeadline)return;state.seconds=Math.max(0,Math.ceil((timerDeadline-Date.now())/1000));if(state.seconds===0){state.status='done';timerDeadline=null;$('feedback').textContent='Your preview timer is up.';}draw();},250);
route();
