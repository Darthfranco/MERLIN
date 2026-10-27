import {createCharacter} from '/character/viewer/character.js';
import {SceneOverlays} from '/character/viewer/overlays/scene-overlays.js';
import {floatingActivityPlan} from './floating-activities.js';
import {formatDuration} from '/character/viewer/panels/render.js';
import {CompanionVoiceClient,unlockAudioPlayback} from './voice-client.js';
import {Orchestrator,ACTION_HOLD,pendingPanel,timerPanel,musicPanel,presentationLayout,panelSides} from './orchestrator.js';
import {TimerAlertQueue} from './timer-alerts.js';

const $=id=>document.getElementById(id);
const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
let sessionId=crypto.randomUUID();
try { const saved=sessionStorage.getItem('merlin-companion-session');if(/^[a-f0-9-]{36}$/i.test(saved||''))sessionId=saved;sessionStorage.setItem('merlin-companion-session',sessionId); }catch{}
let character, floatingOverlays, floatingCount=0;
const floatingSignatures=new Map();
let snapshot={timers:[]}, spotify={connected:false}, serverOffset=0, connected=false;
let requestController, speechController, typedUrl, typedPlayback, pollingTurn=null, turnId=null, generation=0, voiceTurn=null, voiceBefore=[], previousTimers=[];
let completion=Promise.resolve(), pollCount=0, lastDestination='', lastPanelType='', activePanel=null, activePanels={left:null,right:null}, pendingRetry=null;
let sceneRevision=0, sceneCleanup, sceneStatus=null, renderedView=null, firstSnapshot=true, speechPresentation=null;
const speechTurns=new Map(),speechClips=new Map();
const timerAlerts=new TimerAlertQueue();
let panelControlsKey='';
let timerRowsKey='';
let destroyed=false, stateBusy=false, musicBusy=false, timerBusy=new Set(), voiceEnabled=false;
const motionQuery=matchMedia('(prefers-reduced-motion: reduce)');
try{const saved=localStorage.getItem('merlin-read-aloud');$('read-aloud').checked=saved===null||saved==='true';}catch{$('read-aloud').checked=true;}
function notice(text=''){ $('notice').textContent=text;$('notice').hidden=!text; }
function el(tag,text,className){const n=document.createElement(tag);n.textContent=text;if(className)n.className=className;return n;}
async function api(path,body,{signal,timeout=15000}={}){
  const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout)});
  let data;try{data=await response.json();}catch{throw new Error('The connection was interrupted. Check your activities before retrying.');}
  if(!response.ok)throw Object.assign(new Error(data.error||'That request could not finish.'),{data,status:response.status});return data;
}
function livePanel(panel){
  if(panel?.type==='timer'&&panel.id){const t=snapshot.timers.find(t=>t.id===panel.id);return t?timerPanel(t,Date.now()+serverOffset):panel;}
  return panel;
}
function currentPanel(side){return livePanel(side?activePanels[side]:activePanel);}
function scenePresentation(view){
  const plan=floatingActivityPlan({timers:snapshot.timers,spotify,now:Date.now()+serverOffset,
    destination:view.destination,panels:view.panels,maxCards:Number.MAX_SAFE_INTEGER});
  return {...plan,...presentationLayout({...view,destination:plan.destination,panels:plan.physicalPanels},character?.capabilities?.states)};
}
function syncFloatingActivities(plan=scenePresentation(renderedView)){
  floatingCount=plan.activities.length;
  if(!floatingOverlays)return;
  // The rail stays compact throughout actual face entry/return, including a
  // temporary face cover between two retained body arrangements.
  const face=plan.mode==='face'||['face','faceThink','search','camera'].includes(sceneStatus?.state)||/Face/.test(sceneStatus?.clip||'');
  const visiblePlan=face?floatingActivityPlan({timers:snapshot.timers,spotify,now:Date.now()+serverOffset,destination:'face',panels:renderedView.panels,maxCards:Number.MAX_SAFE_INTEGER}):plan;
  floatingOverlays.setPresentation(face?'face':'body');
  const ids=new Set(visiblePlan.cards.map(card=>card.id));
  for(const id of floatingSignatures.keys())if(!ids.has(id)){floatingOverlays.hide(id);floatingSignatures.delete(id);}
  for(const card of visiblePlan.cards){
    const signature=JSON.stringify(card.data);
    if(floatingSignatures.get(card.id)===signature)continue;
    floatingOverlays.show(card.type,card.data,{id:card.id});floatingSignatures.set(card.id,signature);
  }
}
function refreshActivityPresentation(){
  const plan=scenePresentation(renderedView);
  const bindings=panels=>JSON.stringify(['left','right'].map(side=>{const p=panels[side];return p?[p.type,p.id]:null;}));
  if(plan.destination!==lastDestination||bindings(plan.physicalPanels)!==bindings(activePanels))renderView(renderedView);
  else syncFloatingActivities(plan);
}
function updateControlVisibility(){
  const {showControls}=scenePresentation(renderedView);
  const settled=!character||(sceneStatus?.phase==='idle'&&panelSides(sceneStatus.state).length>0);
  $('action-controls').hidden=!showControls||!settled;
  $('close-panel').hidden=!showControls||!settled;
}
function renderView(view){
  renderedView=view;
  $('phase').textContent=view.label;
  const plan=scenePresentation(view),{destination,showControls}=plan;
  activePanels=plan.physicalPanels;activePanel=activePanels[view.focusSide]||null;
  syncFloatingActivities(plan);
  $('stage').dataset.mode=destination;
  $('action-controls').hidden=!showControls;
  $('close-panel').hidden=!showControls;
  if(character){
    for(const side of ['left','right'])if(activePanels[side]){
      // The data follows its card through the ceiling handoff, even while its
      // logical side changes. A side lookup would silently switch identities.
      const panel=activePanels[side];
      character.showPanel(panel.type,()=>livePanel(panel),side,{navigate:false});
    }
    if(lastDestination!==destination||character.desired!==destination)character.go(destination,{preservePanels:Object.values(view.panels||{}).some(Boolean),restorePanels:plan.restorePanels,dismiss:Boolean(view.dismiss),pace:['idle','ambient'].includes(view.phase)?1:4});
    const runtime=character,revision=++sceneRevision;
    sceneCleanup?.abort();const cleanup=new AbortController();sceneCleanup=cleanup;
    void runtime.whenSettled(destination,cleanup.signal).then(settled=>{
      if(!settled||cleanup.signal.aborted||revision!==sceneRevision||runtime!==character)return;
      for(const side of ['left','right'])if(!activePanels[side])runtime.clearPanel(side);
      updateControlVisibility();
    });
    character.setListening(view.phase==='listening'||view.phase==='followup');
    if(view.phase!=='speaking')character.setSpeaking(0);
  }
  lastDestination=destination;lastPanelType=activePanel?.type||'';
  renderPanelControls();
  if(character)updateControlVisibility();
}
const orchestration=new Orchestrator({render:renderView,now:()=>Date.now(),reducedMotion:motionQuery.matches});
const voice=new CompanionVoiceClient({audio:$('voice-audio'),onEvent:voiceEvent,playbackGate:async header=>{
  const g=generation;await completion;if(g!==generation)return false;
  const presentation=speechClips.get(header.utteranceId)||speechTurns.get(`request:${header.requestId}`)||speechTurns.get(`revision:${header.revision}`);
  if(!presentation||presentation.cancelled||presentation.generation!==generation)return false;
  speechClips.set(header.utteranceId,presentation);
  return prepareSpeech(presentation);
}});
async function settleCharacter(destination,g=generation){
  if(!character)return true;
  const runtime=character,abort=new AbortController();
  const timeout=setTimeout(()=>abort.abort(),2500);
  try{
    const settled=await runtime.whenSettled(destination,abort.signal);
    if(g!==generation)return false;
    if(!settled&&abort.signal.aborted&&runtime.desired===destination){runtime.go(destination,{urgent:true,preservePanels:Object.values(renderedView.panels||{}).some(Boolean),restorePanels:scenePresentation(renderedView).restorePanels});return true;}
    return settled;
  }finally{clearTimeout(timeout);}
}
function pinSpeech(destination,{requestId,revision,kind='reply'}={}){
  const presentation={destination,generation,kind};speechPresentation=presentation;
  if(requestId)speechTurns.set(`request:${requestId}`,presentation);
  if(Number.isSafeInteger(revision))speechTurns.set(`revision:${revision}`,presentation);
  return presentation;
}
async function prepareSpeech(presentation){
  if(!presentation||presentation.cancelled||presentation.generation!==generation||document.hidden)return false;
  const target=resolveDestination(presentation.destination);
  orchestration.prepareSpeech({destination:target});
  const settled=await settleCharacter(target,presentation.generation);
  return settled&&!presentation.cancelled&&presentation.generation===generation&&!document.hidden;
}
function resolveDestination(destination){return scenePresentation({...orchestration.view,destination}).destination;}
function renderPanelControls(){
  // Preserve focused/clicked controls when only conversation presence changes.
  const visible=panelSides(lastDestination),layout=renderedView.bodyLayout||'ready';
  const key=JSON.stringify([lastDestination,layout,...['left','right'].map(side=>{const p=currentPanel(side);return p?[side,p.type,p.id,p.label,p.title,p.status,timerBusy.has(p.id)]:null;})]);
  if(key===panelControlsKey)return;panelControlsKey=key;
  const container=$('action-controls');container.replaceChildren();
  for(const side of ['left','right']){
    const p=currentPanel(side);if(!p||!visible.includes(side))continue;
    const location=layout==='ceiling'?'Large screen':side==='left'?'Left':'Right';
    const group=el('div','','panel-controls'),label=el('span',`${location} · ${p.label||p.title||'Action'}`);group.dataset.panelId=p.id||'';group.dataset.panelSide=side;group.append(label);
    if(p.type==='timer'&&p.id){const timer=snapshot.timers.find(t=>t.id===p.id);if(timer){const action=el('button',timer.status==='running'?'Cancel timer':'Dismiss timer');action.dataset.panelId=p.id;action.setAttribute('aria-label',`${timer.status==='running'?'Cancel':'Dismiss'} ${location.toLowerCase()} timer: ${timer.label||'Timer'}`);action.addEventListener('click',()=>changeTimer(timer));action.disabled=timerBusy.has(timer.id);group.append(action);}}
    if(Object.values(activePanels).filter(Boolean).length===1){
      if(layout==='ceiling')for(const dockSide of ['left','right']){const dock=el('button',`Dock ${dockSide}`);dock.dataset.panelId=p.id||'';dock.addEventListener('click',()=>changeLayout(()=>orchestration.dockPanel(dockSide)));group.append(dock);}
      else if(!character||character.capabilities.states.includes('ceiling')){const enlarge=el('button','Enlarge');enlarge.dataset.panelId=p.id||'';enlarge.setAttribute('aria-label',`Enlarge ${location.toLowerCase()} panel: ${p.label||p.title||'Action'}`);enlarge.addEventListener('click',()=>changeLayout(()=>orchestration.expandPanel(side)));group.append(enlarge);}
    }
    const close=el('button','Close panel');close.dataset.panelId=p.id||'';close.setAttribute('aria-label','Close '+location.toLowerCase()+' panel');close.addEventListener('click',()=>changeLayout(()=>orchestration.dismiss(side)));group.append(close);container.append(group);
  }
}
function stopTyped(){const clip=typedPlayback;typedPlayback=null;clip?.finish(false);speechController?.abort();speechController=null;$('typed-audio').pause();$('typed-audio').removeAttribute('src');$('typed-audio').load();$('typed-audio').hidden=true;if(typedUrl){URL.revokeObjectURL(typedUrl);typedUrl=null;}character?.setSpeaking(0);}
function clearSpeech(){for(const presentation of new Set([...speechTurns.values(),...speechClips.values(),speechPresentation]))if(presentation)presentation.cancelled=true;speechTurns.clear();speechClips.clear();speechPresentation=null;}
function changeLayout(change){
  if(speechPresentation){
    clearSpeech();stopTyped();if(voice.active)voice.endConversation();
    if(['reply','speaking','followup'].includes(orchestration.phase)){orchestration.phase='panel';orchestration.speechDestination=orchestration.bodyLayout;}
  }
  change();
}
function invalidate({keepAlert=false}={}){generation++;clearSpeech();if(!keepAlert)timerAlerts.interrupt();requestController?.abort();requestController=null;stopTyped();$('stop').hidden=true;$('send').disabled=!connected;turnId=null;pollingTurn=null;}
function showReply(result){
  $('reply').textContent=result.reply||result.error||'The request finished.';
  $('sources').replaceChildren();for(const source of result.sources||[]){try{const url=new URL(source.url);if(!['https:','http:'].includes(url.protocol))continue;const a=el('a',source.title||url.hostname);a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';const li=el('li','');li.append(a);$('sources').append(li);}catch{}}
  $('sources').hidden=!$('sources').children.length;
  $('actions').replaceChildren();for(const event of result.tool_events||[]){$('actions').append(el('li',event.message||`${event.status==='completed'?'Completed':'Couldn’t finish'} ${event.tool.replaceAll('_',' ')}`));}
  $('actions-empty').hidden=Boolean($('actions').children.length);
}
async function finish(id,result,before,g,voiceContext={}){
  if(g!==generation)return;
  if(Array.isArray(result.timers))acceptSnapshot(result);
  if((result.tool_events||[]).some(e=>e.tool.startsWith('spotify_')))await refreshMusic().catch(()=>{});
  if(g!==generation)return;
  orchestration.result(id,result,{timers:snapshot.timers,previousTimers:before,spotify});
  showReply(result);
  // The accepted reply owns one exact body/face destination through every audio path.
  if(orchestration.phase==='action'){await settleCharacter(lastDestination,g);if(g!==generation)return;await new Promise(resolve=>setTimeout(resolve,ACTION_HOLD));}
  if(g!==generation)return;
  orchestration.reply(id);
  const presentation=pinSpeech(resolveDestination(orchestration.speechDestination),{requestId:id,...voiceContext});
  await settleCharacter(presentation.destination,g);
  if(g!==generation)return;
  $('stop').hidden=true;
  return presentation;
}
async function pollProgress(id,g){
  while(g===generation&&pollingTurn===id){
    try{const progress=await api(`/api/companion/progress?request_id=${encodeURIComponent(id)}`);if(g!==generation||pollingTurn!==id)return;orchestration.progress(id,progress.events);if(['complete','failed','interrupted'].includes(progress.status))return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,300));
  }
}
async function submit(message){
  if(!message.trim())return;
  const retry=pendingRetry?.message===message?pendingRetry:null;
  voice.endConversation();invalidate();const g=generation;
  if($('read-aloud').checked)void(voice.active?voice.unlockPlayback():unlockAudioPlayback($('typed-audio')));
  const id=retry?.id||crypto.randomUUID();turnId=id;pollingTurn=id;previousTimers=[...snapshot.timers];orchestration.begin(id);
  requestController=new AbortController();$('send').disabled=true;$('stop').hidden=false;notice();
  $('heard').textContent=message;$('heard').hidden=false;$('reply').textContent='';$('message').value='';
  void pollProgress(id,g);
  try{
    const result=await api('/api/chat',{message,request_id:id,session_id:sessionId,time_zone:timeZone,channel:'typed'},{signal:requestController.signal,timeout:snapshot.chat_timeout_ms||510000});
    if(g!==generation)return;pendingRetry=null;pollingTurn=null;
    completion=finish(id,result,previousTimers,g);const presentation=await completion;if(g!==generation||!presentation||presentation.cancelled)return;
    if($('read-aloud').checked){if(voice.active)await voice.speakReply(id);else await speak(id,g,{presentation});}
    if(g!==generation||presentation.cancelled||speechPresentation!==presentation)return;orchestration.followup();
  }catch(error){
    if(g!==generation)return;pollingTurn=null;
    if(error.data){completion=finish(id,error.data,previousTimers,g);await completion;if(g!==generation)return;}
    else pendingRetry={id,message};
    orchestration.error('I couldn’t finish that reply');notice(error.message||'Check your activities before trying again.');
    if(!error.data){$('message').value=message;$('send').textContent='Retry';}
  }finally{if(g===generation){turnId=null;pollingTurn=null;requestController=null;$('send').disabled=!connected;$('stop').hidden=true;}}
}
async function speak(id,g,{timer=false,presentation=speechPresentation}={}){
  speechController=new AbortController();const signal=speechController.signal;
  try{
    const response=await fetch(timer?'/api/companion/timer-speech':'/api/companion/speak',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({[timer?'timer_id':'request_id']:id,delivery:'natural',speed:1}),signal});
    if(!response.ok){const data=await response.json();throw new Error(data.error||'Speech is unavailable. Your reply is on screen.');}
    const blob=await response.blob();if(g!==generation||signal.aborted||!presentation||presentation.cancelled)return;
    typedUrl=URL.createObjectURL(blob);const clipUrl=typedUrl;$('typed-audio').src=clipUrl;
    await new Promise(resolve=>{
      const clip={url:clipUrl,presentation,signal,ready:false,gating:false,task:null,finish:resolve};typedPlayback=clip;
      signal.addEventListener('abort',()=>clip.finish(false),{once:true});
      void playTyped(clip);
    });
  }catch(error){if(g===generation&&!signal.aborted)notice(error.message||'Speech is unavailable. Your answer is on screen.');}
}
function validTyped(clip){return typedPlayback===clip&&!clip.signal.aborted&&!clip.presentation.cancelled&&clip.presentation.generation===generation&&$('typed-audio').src===clip.url;}
async function playTyped(clip){
  if(clip.task)return clip.task;
  clip.gating=true;
  clip.task=(async()=>{
    try{
      if(!await prepareSpeech(clip.presentation)||!validTyped(clip)){clip.finish(false);return;}
      clip.ready=true;await $('typed-audio').play();
      if(!validTyped(clip)&&$('typed-audio').src===clip.url)$('typed-audio').pause();
    }catch{
      if(validTyped(clip)){clip.ready=false;$('typed-audio').hidden=false;notice('Press play to hear this reply.');}
      clip.finish(false);
    }finally{clip.gating=false;clip.task=null;}
  })();
  return clip.task;
}
$('typed-audio').addEventListener('play',()=>{
  const clip=typedPlayback;if(!clip)return;
  if(!validTyped(clip)){$('typed-audio').pause();return;}
  if(!clip.ready){clip.gating=true;$('typed-audio').pause();void playTyped(clip);return;}
  orchestration.speaking({destination:clip.presentation.destination});$('stop').hidden=false;
});
for(const event of ['pause','ended'])$('typed-audio').addEventListener(event,()=>{
  const clip=typedPlayback;if(!clip||!validTyped(clip)||clip.gating)return;
  clip.ready=false;character?.setSpeaking(0);$('stop').hidden=true;clip.finish(event==='ended');
  orchestration.followup();
});
$('typed-audio').addEventListener('error',()=>{const clip=typedPlayback;if(!clip||!validTyped(clip))return;clip.finish(false);character?.setSpeaking(0);notice('The spoken reply could not play. Your answer is on screen.');});
function voiceEvent(event){
  if(event.type==='state'){
    const state=event.state;voiceEnabled=!['off','requesting'].includes(state)&&voice.active;
    $('microphone').setAttribute('aria-pressed',String(voice.active));$('microphone').querySelector('span').textContent=voice.active?'Microphone off':'Enable microphone';
    $('mic-state').dataset.on=String(voice.active);
    const names={off:'Microphone off',requesting:'Microphone permission…',starting:'Preparing local listening…',wake:'Mic on · say MERLIN',listening:'Mic on · listening',transcribing:'Transcribing',processing:'Thinking',generating:'Preparing speech',speaking:'Speaking',followup:'Mic on · follow-up'};
    $('mic-state').textContent=names[state]||'Mic on';
    $('test-speaker').disabled=voice.active;
    if(state==='listening'){invalidate();voiceTurn=null;orchestration.listening();notice();}
    else if(state==='transcribing'){voiceBefore=[...snapshot.timers];voiceTurn=`voice-${event.revision}`;orchestration.begin(voiceTurn);}
    else if(state==='wake'&&!turnId){orchestration.standby();}
    else if(state==='off'){if(!turnId){invalidate();voiceTurn=null;orchestration.standby();}}
    else if(state==='followup'&&!turnId){orchestration.followup({external:true});}
  }else if(event.type==='transcript'){
    $('heard').textContent=event.text||event.transcript||'';$('heard').hidden=false;
  }else if(event.type==='progress'){
    if(!voiceTurn){voiceTurn=`voice-${event.revision}`;orchestration.begin(voiceTurn);}
    orchestration.progress(voiceTurn,[event.progress]);
  }else if(event.type==='response'){
    if(!voiceTurn){voiceTurn=`voice-${event.revision}`;orchestration.begin(voiceTurn);}
    completion=finish(voiceTurn,event.response,voiceBefore,generation,{requestId:event.requestId,revision:event.revision});
  }else if(event.type==='notification'){
    if(event.kind==='reply'){$('reply').textContent=event.response.reply;return;}
    const presented=event.response.presentation?.find(p=>p.type==='timer');
    const timer=snapshot.timers.find(t=>t.id===presented?.id)||presented;
    if(timerAlerts.active?.id===timer?.id)timerAlerts.accept(timerAlerts.active);
    if(timer){
      orchestration.timerFinished(timer);showReply(event.response);
      const presentation=pinSpeech(resolveDestination(orchestration.bodyLayout),{revision:event.revision,kind:'timer'});
      completion=settleCharacter(presentation.destination,presentation.generation);
    }
  }else if(event.type==='playback'){
    const presentation=speechClips.get(event.utteranceId);
    if(event.playing){if(presentation&&!presentation.cancelled&&presentation.generation===generation){orchestration.speaking({destination:presentation.destination});$('stop').hidden=false;}}else{character?.setSpeaking(0);$('stop').hidden=true;}
  }else if(event.type==='interrupt'){
    if(['reply-audio','reply-audio-ended'].includes(event.reason))return;
    if(event.reason==='notification-ended'){timerAlerts.release(timerAlerts.active);return;}
    invalidate({keepAlert:event.reason==='notification'});voiceTurn=null;if(!event.reason?.startsWith('notification'))orchestration.listening();
  }else if(event.type==='error'){
    if(timerAlerts.active)timerAlerts.release(timerAlerts.active);
    $('voice-troubleshooting').hidden=false;
    notice(event.message);if(event.fatal)orchestration.error('Voice is unavailable');
    else if(/player|paused/.test(event.message))$('voice-audio').hidden=false;
  }
}
function acceptSnapshot(data){
  if(data.server_time&&Date.parse(data.server_time)<Date.parse(snapshot.server_time||0))return;
  const old=new Map(snapshot.timers.map(t=>[t.id,t.status]));
  if(data.server_time)serverOffset=Date.parse(data.server_time)-Date.now();
  snapshot={...snapshot,...data,timers:data.timers||snapshot.timers};
  if(firstSnapshot){firstSnapshot=false;orchestration.restoreTimers(snapshot.timers);}
  else orchestration.syncTimers(snapshot.timers);
  renderTimers();refreshActivityPresentation();
  for(const t of snapshot.timers)if(t.status==='completed'&&old.has(t.id)&&old.get(t.id)!=='completed'){
    timerAlerts.enqueue(t);
    // Announcements wait for conversation quiet, while Activity updates immediately.
  }
  if(data.warning)notice(data.warning);
}
async function drainAlerts(){
  const ready=!destroyed&&document.visibilityState!=='hidden'&&!turnId&&['idle','ambient','panel'].includes(orchestration.phase)&&(!voice.active||voice.state==='wake');
  const token=timerAlerts.claim(ready);if(!token)return;
  const {id,timer}=token;
  if(!snapshot.timers.some(t=>t.id===id&&t.status==='completed')){timerAlerts.release(token);return;}
  if(!orchestration.timerFinished(timer)){timerAlerts.release(token,{retry:true});return;}
  const presentation=pinSpeech(resolveDestination(orchestration.bodyLayout),{kind:'timer'});
  $('reply').textContent=`${timer.label||'Your timer'} is finished.`;
  if(voice.active){
    if(voice.announceTimer?.(id))timerAlerts.waiting(token);else timerAlerts.release(token,{retry:true});
    return;
  }
  try{
    if($('read-aloud').checked){
      const g=generation;await settleCharacter(presentation.destination,g);
      if(g!==generation||timerAlerts.active!==token)return;
      if(!$('read-aloud').checked){timerAlerts.accept(token);return;}
      timerAlerts.accept(token);await speak(id,g,{timer:true,presentation});
      if(g===generation&&!presentation.cancelled){orchestration.phase='panel';orchestration.show(orchestration.bodyDestination(),'Timer finished');$('stop').hidden=true;}
    }else timerAlerts.accept(token);
  }finally{timerAlerts.release(token);}
}
function renderTimers(){
  const key=JSON.stringify([snapshot.timers,[...timerBusy]]);
  if(key===timerRowsKey){countdowns();return;}timerRowsKey=key;
  const focused=document.activeElement?.dataset?.timerAction;
  $('timers').replaceChildren();$('timers-empty').hidden=snapshot.timers.length>0;
  $('timer-count').textContent=snapshot.timers.length?`· ${snapshot.timers.filter(t=>t.status==='running').length} running`:'';
  for(const timer of snapshot.timers){
    const row=el('article','','timer-row'),heading=el('div','','timer-heading'),label=el('button',timer.label||'Timer'),remaining=el('span','','timer-time');
    label.dataset.timerAction=`show-${timer.id}`;label.addEventListener('click',()=>orchestration.inspect(timerPanel(timer,Date.now()+serverOffset)));
    remaining.dataset.timerId=timer.id;heading.append(label,remaining);row.append(heading);
    const zone=timer.time_zone||timeZone;let end='';try{end=new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit',timeZone:zone}).format(new Date(timer.ends_at));}catch{}
    row.append(el('p',`${timer.status==='running'?'Ends':'End time'} ${end} · ${zone}`,'timer-meta'));
    const action=el('button',timer.status==='running'?'Cancel':'Dismiss');action.dataset.timerAction=timer.id;action.disabled=timerBusy.has(timer.id);action.addEventListener('click',()=>changeTimer(timer));row.append(action);$('timers').append(row);
  }
  if(focused)Array.from($('timers').querySelectorAll('button')).find(b=>b.dataset.timerAction===focused)?.focus({preventScroll:true});
  countdowns();
}
function countdowns(){
  for(const node of $('timers').querySelectorAll('[data-timer-id]')){const t=snapshot.timers.find(t=>t.id===node.dataset.timerId);if(!t)continue;const seconds=Math.max(0,Math.ceil((Date.parse(t.ends_at)-Date.now()-serverOffset)/1000));node.textContent=t.status==='completed'?'Finished':t.status==='cancelled'?'Stopped':seconds===0?'Confirming…':formatDuration(seconds);}
}
async function changeTimer(timer){
  if(timerBusy.has(timer.id))return;timerBusy.add(timer.id);renderTimers();renderPanelControls();
  try{acceptSnapshot(await api(`/api/timers/${encodeURIComponent(timer.id)}/${timer.status==='running'?'cancel':'dismiss'}`,{}));for(const side of ['left','right'])if(activePanels[side]?.type==='timer'&&!snapshot.timers.some(t=>t.id===activePanels[side]?.id))orchestration.dismiss(side);}
  catch(error){notice(error.message);}finally{timerBusy.delete(timer.id);renderTimers();renderPanelControls();}
}
function acceptMusic(data){
  spotify=data;orchestration.musicPlaying=spotify.connected===true&&spotify.playback?.is_playing===true;renderMusic();
  const next=musicPanel(spotify),signature=JSON.stringify(next);let changed=false;
  // Floating layouts conceal physical bindings, but their retained records must
  // still follow every confirmed playback/connection change before returning.
  for(const side of ['left','right'])if(orchestration.panels[side]?.type==='music'&&JSON.stringify(orchestration.panels[side])!==signature){
    orchestration.panels[side]=next;if(orchestration.focusSide===side)orchestration.panel=next;changed=true;
  }
  if(changed)orchestration.show(orchestration.view.destination,orchestration.view.label);
  else refreshActivityPresentation();
}
async function refreshMusic(){
  try{acceptMusic(await api('/api/spotify?refresh=1'));}
  catch(error){$('music-notice').textContent=error.message;throw error;}
}
function renderMusic(){
  const connected=spotify.connected===true;$('spotify-state').textContent=connected?'Connected':'Not connected';$('spotify-controls').hidden=!connected;
  const old=$('spotify-device').value;$('spotify-device').replaceChildren(new Option('Choose a device',''));
  for(const device of spotify.devices||[]){const option=new Option(device.name||'Spotify device',device.id);option.disabled=device.is_restricted===true;$('spotify-device').append(option);}
  const devices=(spotify.devices||[]).filter(d=>!d.is_restricted);$('spotify-device').value=devices.find(d=>d.id===old)?.id||devices.find(d=>d.is_active)?.id||'';
  $('track').textContent=spotify.playback?.track?.name||(connected?'Nothing playing':'Spotify is not connected');$('artist').textContent=spotify.playback?.track?.artists?.join(', ')||'';
  $('play-pause').textContent=spotify.playback?.is_playing?'Pause':'Play';
  for(const id of ['previous','play-pause','next'])$(id).disabled=musicBusy||!connected||!$('spotify-device').value;
}
async function musicControl(action){
  if(musicBusy)return;musicBusy=true;orchestration.inspect(pendingPanel('music'));renderMusic();$('music-notice').textContent='';
  try{await api('/api/spotify/control',{request_id:crypto.randomUUID(),action,device_id:$('spotify-device').value});await refreshMusic();orchestration.inspect(musicPanel(spotify));}
  catch(error){$('music-notice').textContent=error.message;orchestration.inspect(pendingPanel('music','error'));}finally{musicBusy=false;renderMusic();}
}
async function pollState(){
  if(destroyed||stateBusy)return;stateBusy=true;
  try{const state=await api('/api/companion/state');connected=state.configured===true;acceptSnapshot(state);
    $('connection').textContent=connected?'At home · Ready':'Assistant not connected';
    if(!connected)notice('The assistant is not connected yet. You can still view local timers.');
    $('send').disabled=!connected||Boolean(turnId);
    const status=state.services?.spotify;$('spotify-state').textContent=status?.connected?'Connected':'Not connected';
    if(!status?.connected)acceptMusic({connected:false});
    else if(pollCount++%5===0)void refreshMusic().catch(()=>{});
  }catch{connected=false;$('connection').textContent='Connection lost · Reconnecting';$('send').disabled=true;}
  finally{stateBusy=false;}
}
function toggleActivity(open){$('activity').hidden=!open;$('activity-toggle').setAttribute('aria-expanded',String(open));if(open&&innerWidth<=720)$('activity').scrollIntoView({behavior:motionQuery.matches?'auto':'smooth',block:'start'});}
$('activity-toggle').addEventListener('click',()=>toggleActivity($('activity').hidden));$('activity-close').addEventListener('click',()=>{toggleActivity(false);$('activity-toggle').focus();});
$('chat-form').addEventListener('submit',event=>{event.preventDefault();void submit($('message').value.trim());});
$('message').addEventListener('focus',()=>{if(!turnId&&!voice.active){invalidate();orchestration.listening({typed:true});}});
$('message').addEventListener('blur',()=>{if(orchestration.phase==='listening'&&!voice.active&&!turnId)orchestration.followup();});
$('message').addEventListener('input',()=>{$('send').textContent=pendingRetry?.message===$('message').value.trim()?'Retry':'Send';});
$('microphone').addEventListener('click',async()=>{notice();if(voice.active){invalidate();voice.stop();return;}invalidate();try{await voice.start({sessionId,timeZone});}catch(error){notice(error.message);$('voice-troubleshooting').hidden=false;}});
$('stop').addEventListener('click',()=>{invalidate();voice.interrupt();if(voice.active)orchestration.listening();else orchestration.followup();notice('Reply stopped. Completed actions are still in Activity.');});
$('close-panel').addEventListener('click',()=>changeLayout(()=>orchestration.dismiss()));$('reload-scene').addEventListener('click',()=>location.reload());
for(const button of document.querySelectorAll('[data-service]'))button.addEventListener('click',()=>{const type=button.dataset.service;orchestration.inspect(type==='music'?musicPanel(spotify):pendingPanel(type,'offline'));if(type!=='music')notice(type==='schedule'?'Schedules aren’t available yet.':'This home service isn’t connected yet.');});
$('previous').addEventListener('click',()=>musicControl('previous'));$('next').addEventListener('click',()=>musicControl('next'));$('play-pause').addEventListener('click',()=>musicControl(spotify.playback?.is_playing?'pause':'play'));$('spotify-device').addEventListener('change',renderMusic);$('refresh-music').addEventListener('click',()=>refreshMusic().catch(()=>{}));
$('clear-conversation').addEventListener('click',async()=>{invalidate();voice.stop();try{await api('/api/session/reset',{session_id:sessionId});$('heard').hidden=true;$('reply').textContent='Ready for a fresh conversation.';$('actions').replaceChildren();$('actions-empty').hidden=false;$('sources').hidden=true;pendingRetry=null;orchestration.standby();notice('This conversation was cleared. Your timers and panels are still here.');}catch(error){notice(error.message);}});
$('read-aloud').addEventListener('change',()=>{try{localStorage.setItem('merlin-read-aloud',String($('read-aloud').checked));}catch{}if(!$('read-aloud').checked){stopTyped();if(turnId&&voice.active)voice.interrupt();}else void unlockAudioPlayback($('typed-audio'));});
$('test-speaker').addEventListener('click',async()=>{
  invalidate();const g=generation;void unlockAudioPlayback($('typed-audio'));$('test-speaker').disabled=true;notice('Preparing a short speaker test…');
  try{
    speechController=new AbortController();
    const response=await fetch('/api/companion/audio-check',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:speechController.signal});
    if(!response.ok){const body=await response.json();throw new Error(body.error||'Speech is unavailable.');}
    const blob=await response.blob();if(g!==generation)return;
    typedUrl=URL.createObjectURL(blob);const clipUrl=typedUrl,audio=$('typed-audio');audio.src=clipUrl;audio.hidden=false;
    const ended=()=>{if(g===generation&&audio.src===clipUrl)notice('Speaker test complete. If you heard nothing, check your sound output and volume.');};
    audio.addEventListener('ended',ended,{once:true,signal:speechController.signal});
    try{await $('typed-audio').play();notice('Speaker test playing. If it is silent, check your sound output and volume.');}
    catch{notice('Press play below to test your speakers.');}
  }catch(error){if(g===generation){notice(error.message);$('voice-troubleshooting').hidden=false;}}
  finally{$('test-speaker').disabled=voice.active;}
});
motionQuery.addEventListener('change',()=>{orchestration.reducedMotion=motionQuery.matches;if(motionQuery.matches&&orchestration.phase==='ambient')orchestration.standby();});
const ticker=setInterval(()=>{if(document.hidden)return;if(!floatingCount||!['idle','ambient'].includes(orchestration.phase))orchestration.tick();countdowns();syncFloatingActivities();void drainAlerts();if(orchestration.phase==='speaking')character?.setSpeaking(.65);},500);
const statePoll=setInterval(()=>{if(document.visibilityState!=='hidden')void pollState();},2000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){invalidate();voice.stop();orchestration.standby();}else void pollState();});
window.addEventListener('pagehide',()=>{destroyed=true;invalidate();voice.destroy();floatingOverlays?.destroy();character?.destroy();clearInterval(ticker);clearInterval(statePoll);},{once:true});
void pollState();
createCharacter({canvas:$('scene'),stage:$('scene-frame'),onStatus:info=>{
  if(info?.message)$('loading').textContent=info.message;
  if(info?.state){sceneStatus=info;Object.assign($('stage').dataset,{characterState:info.state,characterDesired:info.desired||'',characterClip:info.clip||'',motionPhase:info.phase||''});if(character){updateControlVisibility();syncFloatingActivities();}}
},onError:()=>{$('scene-error').hidden=false;}}).then(runtime=>{character=runtime;floatingOverlays=new SceneOverlays($('scene-frame'),{clock:runtime,presentation:'companion'});$('loading').hidden=true;lastDestination='';renderView(orchestration.view);}).catch(()=>{$('loading').hidden=true;$('scene-error').hidden=false;});
