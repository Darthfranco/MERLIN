import {createCharacter} from '/character/viewer/character.js';
import {SceneOverlays} from '/character/viewer/overlays/scene-overlays.js';
import {floatingActivityPlan} from './floating-activities.js';
import {formatDuration,panelActions,PANEL_WIDTH,PANEL_HEIGHT} from '/character/viewer/panels/render.js';
import {CompanionVoiceClient,unlockAudioPlayback} from './voice-client.js';
import {Orchestrator,ACTION_HOLD,pendingPanel,timerPanel,musicPanel,presentationLayout,panelSides} from './orchestrator.js';
import {TimerAlertQueue} from './timer-alerts.js';
import {panelState,initialUi,applyAction,connectionsPanelRecord,connectorSummary} from './connections-panel.js';
import {connectionTargets,pageCount} from '/character/viewer/panels/connections.js';
import {playOfferTargets,playOfferDescription} from '/character/viewer/panels/play-offer.js';
import {AcknowledgmentCoordinator,AcknowledgmentPlayer,loadAcknowledgmentClips} from './acknowledgments.js';
import {captureFrame,cameraErrorCode,checkDeviceCamera,paintViewfinder} from './device-camera.js';

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
let connectionsUi=initialUi({}), touchKey='', connectionsBusy=false, offerUi={status:'ready'};
const largeScreen=type=>type==='connections'||type==='music-offer';
// /companionfull/: the robot-only home display. Voice is the input; speech and acknowledgments are always on.
const FULL=document.documentElement?.dataset?.mode==='full';
let micMuted=false, touchKeyLeft='';
let timerRowsKey='';
let destroyed=false, stateBusy=false, musicBusy=false, timerBusy=new Set(), voiceEnabled=false;
let cameraCapture=null, consentTimer=null;const seenCaptures=new Set(),viewfinder={source:null,segments:[],count:0,note:'',scanning:false};
const VIEWFINDER_HOLD=1600;
const motionQuery=matchMedia('(prefers-reduced-motion: reduce)');
try{const saved=localStorage.getItem('merlin-read-aloud');$('read-aloud').checked=saved===null||saved==='true';}catch{$('read-aloud').checked=true;}
try{$('acknowledgments').checked=localStorage.getItem('merlin-acknowledgments')!=='false';}catch{$('acknowledgments').checked=true;}
if(FULL){$('read-aloud').checked=true;$('acknowledgments').checked=true;}
function notice(text=''){ $('notice').textContent=text;$('notice').hidden=!text; }
function el(tag,text,className){const n=document.createElement(tag);n.textContent=text;if(className)n.className=className;return n;}
async function api(path,body,{signal,timeout=15000}={}){
  const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout)});
  let data;try{data=await response.json();}catch{throw new Error('The connection was interrupted. Check your activities before retrying.');}
  if(!response.ok)throw Object.assign(new Error(data.error||'That request could not finish.'),{data,status:response.status});return data;
}
function livePanel(panel){
  if(panel?.type==='connections')return {...panel,...panelState(connectionsUi,{connectors:snapshot.connectors||[],spotify}),closable:FULL};
  if(panel?.type==='music-offer')return {...panel,...offerUi,closable:FULL};
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
    // On the home display the music card's own button pauses and resumes; Spotify is only ever touched by a tap.
    floatingOverlays.show(card.type,card.data,{id:card.id,...(FULL&&card.type==='music'?{onAction:({action})=>void musicControl(action==='pause'?'pause':'play')}:{})});floatingSignatures.set(card.id,signature);
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
  renderTouchLayer();
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
    if(view.phase!=='speaking'&&!view.acknowledging)character.setSpeaking(0);
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
  // The answer's pose and a started filler resolve together, so the reply follows its last word directly.
  const [ready]=await Promise.all([prepareSpeech(presentation),acknowledgments.beforeAnswer()]);
  return ready&&!presentation.cancelled&&presentation.generation===generation&&!document.hidden;
}});
const acknowledgments=new AcknowledgmentCoordinator({player:new AcknowledgmentPlayer($('ack-audio')),onAudible:(audible,{resume}={})=>{
  orchestration.acknowledgment(audible,{resume:audible||resume});
  voice.reportAcknowledgment(audible);
  if(audible){character?.setSpeaking(.65);$('stop').hidden=false;}
  else if(orchestration.phase!=='speaking'){character?.setSpeaking(0);$('stop').hidden=!requestController;}
}});
void loadAcknowledgmentClips({fetchImpl:fetch,createObjectURL:blob=>URL.createObjectURL(blob),subtle:crypto.subtle}).then(({version,clips})=>acknowledgments.setClips(version,clips)).catch(()=>{});
// Speech output is checked at the moment a clip would start, so a later change applies immediately.
// The middle of the spoken answer for a search: the server's "looking it up" line, fetched as soon as it exists.
const lookupLinesAsked=new Set();
function lookupLine(id,events){
  if(!id||lookupLinesAsked.has(id)||!events?.some(event=>event?.stage==='lookup_line')||!acknowledgments.wantsLine(id))return;
  lookupLinesAsked.add(id);if(lookupLinesAsked.size>50)lookupLinesAsked.delete(lookupLinesAsked.values().next().value);
  void fetch('/api/companion/lookup-speech',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:id,delivery:'natural',speed:1})}).then(async response=>{
    if(!response.ok)return;
    const bytes=await response.arrayBuffer(),url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
    acknowledgments.line(id,{id:'lookup',url,durationMs:Math.max(500,(bytes.byteLength-44)/48),release:()=>URL.revokeObjectURL(url)});
  }).catch(()=>{});
}
function armAcknowledgment(id,token,typed=false){
  acknowledgments.arm(id,{token,isEnabled:()=>{
    const reply=$(typed&&!voice.active?'typed-audio':'voice-audio');
    const enabled=$('acknowledgments').checked&&(!typed||$('read-aloud').checked)&&!document.hidden&&!reply.muted&&reply.volume!==0;
    if(enabled)$('ack-audio').volume=reply.volume;
    return enabled;
  }});
}
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
    const group=el('div','','panel-controls'),label=el('span',`${location} · ${p.type==='connections'?'Connect your home':p.label||p.title||'Action'}`);group.dataset.panelId=p.id||'';group.dataset.panelSide=side;group.append(label);
    if(p.type==='timer'&&p.id){const timer=snapshot.timers.find(t=>t.id===p.id);if(timer){const action=el('button',timer.status==='running'?'Cancel timer':'Dismiss timer');action.dataset.panelId=p.id;action.setAttribute('aria-label',`${timer.status==='running'?'Cancel':'Dismiss'} ${location.toLowerCase()} timer: ${timer.label||'Timer'}`);action.addEventListener('click',()=>changeTimer(timer));action.disabled=timerBusy.has(timer.id);group.append(action);}}
    if(!largeScreen(p.type)&&Object.values(activePanels).filter(Boolean).length===1){
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
    clearSpeech();acknowledgments.cancel();stopTyped();if(voice.active)voice.endConversation();
    if(['reply','speaking','followup'].includes(orchestration.phase)){orchestration.phase='panel';orchestration.speechDestination=orchestration.bodyLayout;}
  }
  change();
}
const cameraMedia=()=>globalThis.navigator?.mediaDevices;
// Availability only: this never opens the camera or prompts for it. The server needs to know before it offers to look.
async function reportCamera(){try{await api('/api/companion/camera/status',{session_id:sessionId,...await checkDeviceCamera(cameraMedia())});}catch{}}
function showCameraOn(on,count=0){$('camera-state').textContent=on?`Camera on${count?` · ${count}`:''}`:'Camera off';$('camera-state').dataset.on=String(on);}
function hideConsent(){clearTimeout(consentTimer);consentTimer=null;$('camera-consent').hidden=true;}
// The server stops honoring a yes after two minutes, so the buttons don't outlast it.
function showConsent(){hideConsent();$('camera-consent').hidden=false;consentTimer=setTimeout(hideConsent,120000);}
function closeCameraView(){
  character?.clearViewfinder?.();Object.assign(viewfinder,{source:null,segments:[],count:0,note:'',scanning:false});
  $('camera-close').hidden=true;const still=$('camera-still');if(still.width){still.width=0;still.height=0;}
}
function endCapture(){if(!cameraCapture)return;cameraCapture.controller.abort();cameraCapture=null;}
/** The server asked for the one frame a yes allows. Whatever happens, the camera is off again when this returns. */
async function runCapture(id){
  if(seenCaptures.has(id))return;seenCaptures.add(id);hideConsent();
  const capture={id,controller:new AbortController(),closed:false};cameraCapture=capture;
  // Shown on the camera face's own viewfinder, so the authored synthetic picture never reads as a real feed.
  viewfinder.note='Starting the camera…';$('camera-close').hidden=false;
  character?.showViewfinder?.((context,width,height,seconds)=>paintViewfinder(context,width,height,{...viewfinder,seconds}));
  let answer;
  try{
    const image=await captureFrame({media:cameraMedia(),video:$('camera-video'),canvas:$('camera-still'),signal:capture.controller.signal,
      onLive:()=>{showCameraOn(true);Object.assign(viewfinder,{source:$('camera-video'),note:''});},
      onCountdown:left=>{viewfinder.count=left;showCameraOn(true,left);}});
    answer={capture_id:id,image};
  }catch(error){answer={capture_id:id,error:cameraErrorCode(error)};}
  showCameraOn(false);$('camera-close').hidden=true;
  if(cameraCapture===capture)cameraCapture=null;
  // The whole turn was stopped, so the server has already given up on this frame.
  const stale=capture.controller.signal.aborted&&!capture.closed;
  if(answer.image&&!stale)Object.assign(viewfinder,{source:$('camera-still'),count:0,scanning:!motionQuery.matches});
  else closeCameraView();
  if(!stale)try{await api('/api/companion/camera/frame',answer,{timeout:30000});}catch{}
}
function cameraEvents(events){for(const event of events||[])if(event.stage==='camera_capture'&&event.capture_id)void runCapture(event.capture_id);}
function showCameraResult(camera){
  if(camera?.state==='asking'){showConsent();return;}
  hideConsent();
  if(camera?.state==='looked'&&viewfinder.source)Object.assign(viewfinder,{segments:camera.segments||[],scanning:false});
  else closeCameraView();
}
function invalidate({keepAlert=false}={}){endCapture();hideConsent();closeCameraView();generation++;clearSpeech();acknowledgments.cancel();if(!keepAlert)timerAlerts.interrupt();requestController?.abort();requestController=null;stopTyped();$('stop').hidden=true;$('send').disabled=!connected;turnId=null;pollingTurn=null;}
function showReply(result){
  $('reply').textContent=result.reply||result.error||'The request finished.';
  $('sources').replaceChildren();for(const source of result.sources||[]){try{const url=new URL(source.url);if(!['https:','http:'].includes(url.protocol))continue;const a=el('a',source.title||url.hostname);if(source.snippet)a.title=String(source.snippet).slice(0,280);a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';const li=el('li','');li.append(a);$('sources').append(li);}catch{}}
  $('sources').setAttribute('aria-label',(result.sources||[]).length&&(result.sources||[]).every(source=>['retrieved','read'].includes(source.basis))?'Pages checked for this answer':'Answer sources');
  $('sources').hidden=!$('sources').children.length;
  $('actions').replaceChildren();for(const event of result.tool_events||[]){$('actions').append(el('li',event.message||`${event.status==='completed'?'Completed':'Couldn’t finish'} ${event.tool.replaceAll('_',' ')}`));}
  $('actions-empty').hidden=Boolean($('actions').children.length);
}
async function finish(id,result,before,g,voiceContext={}){
  if(g!==generation)return;
  if(Array.isArray(result.timers))acceptSnapshot(result);
  if((result.tool_events||[]).some(e=>e.tool.startsWith('spotify_')))await refreshMusic().catch(()=>{});
  if(g!==generation)return;
  const connectionCard=(result.presentation||[]).find(card=>card.type==='connections');
  if(connectionCard&&(result.tool_events||[]).some(event=>event.tool==='show_connections'&&event.status==='completed')){connectionsUi=initialUi(connectionCard);touchKey='';}
  if((result.presentation||[]).some(card=>card.type==='music-offer')){offerUi={status:'ready'};touchKey='';}
  orchestration.result(id,result,{timers:snapshot.timers,previousTimers:before,spotify});
  showReply(result);showCameraResult(result.camera);
  // What SAM 3.1 found stays on the viewfinder for a moment before MERLIN turns to speak.
  if(viewfinder.segments.length){orchestration.looked(id);await new Promise(resolve=>setTimeout(resolve,VIEWFINDER_HOLD));if(g!==generation)return;}
  // The accepted reply owns one exact body/face destination through every audio path.
  if(orchestration.phase==='action'){await settleCharacter(lastDestination,g);if(g!==generation)return;await new Promise(resolve=>setTimeout(resolve,ACTION_HOLD));}
  if(g!==generation)return;
  orchestration.reply(id);
  const presentation=pinSpeech(resolveDestination(orchestration.speechDestination),{requestId:id,...voiceContext});
  await settleCharacter(presentation.destination,g);
  if(g!==generation)return;
  // The speaking face has covered the viewfinder, so the picture can go.
  closeCameraView();
  $('stop').hidden=!orchestration.acknowledging;
  return presentation;
}
async function pollProgress(id,g){
  while(g===generation&&pollingTurn===id){
    try{const progress=await api(`/api/companion/progress?request_id=${encodeURIComponent(id)}`);if(g!==generation||pollingTurn!==id)return;orchestration.progress(id,progress.events);cameraEvents(progress.events);acknowledgments.allow(id,progress.events?.find(event=>event.stage==='received')?.acknowledgments);lookupLine(id,progress.events);if(['complete','failed','interrupted'].includes(progress.status)){acknowledgments.settled(id);return;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,300));
  }
}
async function submit(message){
  if(!message.trim())return;
  const retry=pendingRetry?.message===message?pendingRetry:null;
  voice.endConversation();invalidate();const g=generation;
  if($('read-aloud').checked){void(voice.active?voice.unlockPlayback():unlockAudioPlayback($('typed-audio')));if($('acknowledgments').checked)void unlockAudioPlayback($('ack-audio'));}
  const id=retry?.id||crypto.randomUUID();turnId=id;pollingTurn=id;previousTimers=[...snapshot.timers];orchestration.begin(id);
  requestController=new AbortController();$('send').disabled=true;$('stop').hidden=false;notice();
  $('heard').textContent=message;$('heard').hidden=false;$('reply').textContent='';$('message').value='';
  armAcknowledgment(id,g,true);
  void pollProgress(id,g);
  try{
    const result=await api('/api/chat',{message,request_id:id,session_id:sessionId,time_zone:timeZone,channel:'typed'},{signal:requestController.signal,timeout:snapshot.chat_timeout_ms||510000});
    if(g!==generation)return;pendingRetry=null;pollingTurn=null;acknowledgments.settled(id);
    // Final speech generates while the reply settles on screen and any filler finishes, not after.
    const speech=$('read-aloud').checked&&!voice.active?requestSpeech(id):null;
    completion=finish(id,result,previousTimers,g);const presentation=await completion;if(g!==generation||!presentation||presentation.cancelled)return;
    if($('read-aloud').checked){if(voice.active)await voice.speakReply(id);else await speak(id,g,{presentation,...(speech?{request:speech}:{})});}
    if(g!==generation||presentation.cancelled||speechPresentation!==presentation)return;orchestration.followup();
  }catch(error){
    if(g!==generation)return;pollingTurn=null;acknowledgments.settled(id);
    if(error.data){completion=finish(id,error.data,previousTimers,g);await completion;if(g!==generation)return;}
    else pendingRetry={id,message};
    orchestration.error('I couldn’t finish that reply');notice(error.message||'Check your activities before trying again.');
    if(!error.data){$('message').value=message;$('send').textContent='Retry';}
  }finally{if(g===generation){turnId=null;pollingTurn=null;requestController=null;$('send').disabled=!connected;$('stop').hidden=true;}}
}
function requestSpeech(id,{timer=false}={}){
  speechController=new AbortController();const signal=speechController.signal;
  const blob=fetch(timer?'/api/companion/timer-speech':'/api/companion/speak',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({[timer?'timer_id':'request_id']:id,delivery:'natural',speed:1}),signal}).then(async response=>{
    if(!response.ok){const data=await response.json();throw new Error(data.error||'Speech is unavailable. Your reply is on screen.');}
    return response.blob();
  });
  blob.catch(()=>{});
  return {signal,blob};
}
async function speak(id,g,{timer=false,presentation=speechPresentation,request=requestSpeech(id,{timer})}={}){
  const {signal}=request;
  try{
    const blob=await request.blob;if(g!==generation||signal.aborted||!presentation||presentation.cancelled)return;
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
      await acknowledgments.beforeAnswer();
      if(!validTyped(clip)){clip.finish(false);return;}
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
    const state=event.state;voiceEnabled=!['off','requesting'].includes(state)&&voice.active;if(FULL)renderFullMic(state);
    $('microphone').setAttribute('aria-pressed',String(voice.active));$('microphone').querySelector('span').textContent=voice.active?'Microphone off':'Enable microphone';
    $('mic-state').dataset.on=String(voice.active);
    const names={off:'Microphone off',requesting:'Microphone permission…',starting:'Preparing local listening…',wake:'Mic on · say MERLIN',listening:'Mic on · listening',transcribing:'Transcribing',processing:'Thinking',generating:'Preparing speech',speaking:'Speaking',followup:'Mic on · follow-up'};
    $('mic-state').textContent=names[state]||'Mic on';
    $('test-speaker').disabled=voice.active;
    if(state==='listening'){invalidate();voiceTurn=null;orchestration.listening();notice();}
    else if(state==='transcribing'){voiceBefore=[...snapshot.timers];voiceTurn=`voice-${event.revision}`;orchestration.begin(voiceTurn);}
    // Speech over a working request that turned out not to be one: back to thinking about the request still running.
    else if(state==='processing'&&!voiceTurn){voiceTurn=`voice-${event.revision}`;orchestration.begin(voiceTurn);}
    else if(state==='wake'&&!turnId){orchestration.standby();}
    else if(state==='off'){if(!turnId){invalidate();voiceTurn=null;orchestration.standby();}}
    else if(state==='followup'&&!turnId){orchestration.followup({external:true});}
  }else if(event.type==='transcript'){
    $('heard').textContent=event.text||event.transcript||'';$('heard').hidden=false;
    if(event.requestId)armAcknowledgment(event.requestId,`${generation}:${event.revision}`);
  }else if(event.type==='progress'){
    if(!voiceTurn){voiceTurn=`voice-${event.revision}`;orchestration.begin(voiceTurn);}
    orchestration.progress(voiceTurn,[event.progress]);
    cameraEvents([event.progress]);
    acknowledgments.allow(event.requestId,event.progress?.acknowledgments);
    lookupLine(event.requestId,[event.progress]);
  }else if(event.type==='response'){
    if(!voiceTurn){voiceTurn=`voice-${event.revision}`;orchestration.begin(voiceTurn);}
    acknowledgments.settled(event.requestId);
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
    acknowledgments.settled();
    $('voice-troubleshooting').hidden=false;
    notice(event.message);if(event.fatal)orchestration.error('Voice is unavailable');if(FULL&&event.fatal&&!micMuted)showStart(event.message);
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
  renderTimers();refreshActivityPresentation();refreshConnections();
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
  try{const device=$('spotify-device').value;await api('/api/spotify/control',{request_id:crypto.randomUUID(),action,...(device?{device_id:device}:{})});await refreshMusic();orchestration.inspect(musicPanel(spotify));}
  catch(error){$('music-notice').textContent=error.message;orchestration.inspect(pendingPanel('music','error'));}finally{musicBusy=false;renderMusic();}
}
async function pollState(){
  if(destroyed||stateBusy)return;stateBusy=true;
  try{const state=await api('/api/companion/state');const reconnected=!connected&&state.configured===true;connected=state.configured===true;acceptSnapshot(state);if(reconnected)void reportCamera();
    $('connection').textContent=connected?'At home · Ready':'Assistant not connected';
    if(!connected)notice('The assistant is not connected yet. You can still view local timers.');
    $('send').disabled=!connected||Boolean(turnId);
    acknowledgments.configure(state.acknowledgments);
    const status=state.services?.spotify;$('spotify-state').textContent=status?.connected?'Connected':'Not connected';
    const serviceState=service=>service?.connected?(service.simulated?'Demo (simulated)':'Connected'):'Not connected';
    $('lights-state').textContent=serviceState(state.services?.lights);$('oven-state').textContent=serviceState(state.services?.oven);
    if(!status?.connected)acceptMusic({connected:false});
    else if(pollCount++%5===0)void refreshMusic().catch(()=>{});
  }catch{connected=false;$('connection').textContent='Connection lost · Reconnecting';$('send').disabled=true;}
  finally{stateBusy=false;}
}
function openConnections(card){
  connectionsUi=initialUi(card);touchKey='';
  if(!orchestration.inspectLarge(connectionsPanelRecord()))notice('Finish this reply first, then open the connection options.');
}
function announceConnections(){$('touch-status').textContent=connectionsUi.announce||connectionsUi.notice||'';}
function refreshConnections(){
  if(!largeScreen(activePanels.right?.type))return;
  character?.refreshPanels?.(['right']);renderTouchLayer();
}
function renderTouchLayer(){renderSideTouch('right');renderSideTouch('left');}
/** What can be tapped on one screen, in that screen's drawing units. */
function sideTargets(side,panel,width,height){
  const state=livePanel(panel);
  if(side==='right'&&panel.type==='music-offer')return {targets:playOfferTargets(state,width,height),width,height};
  if(side==='right'&&panel.type==='connections')return {targets:connectionTargets(state,width,height),width,height};
  // The home display: each regular panel's own large controls, in its 900 × 1080 design units, at their full tap areas.
  if(FULL&&!largeScreen(panel.type))return {targets:panelActions(state,{touch:true}).map(target=>({...target,...target.hit})),width:PANEL_WIDTH,height:PANEL_HEIGHT};
  return null;
}
function renderSideTouch(side){
  const layer=$(side==='right'?'touch-layer':'touch-layer-left'),panel=activePanels[side],geometry=character?.screenGeometry?.(side);
  const clear=()=>{if(!layer.hidden){layer.replaceChildren();layer.hidden=true;}if(side==='right')touchKey='';else touchKeyLeft='';};
  // Real buttons sit over a painted screen only once MERLIN has finished bringing it out.
  const settled=geometry&&panel&&sceneStatus?.phase==='idle'&&scenePresentation(renderedView).destination===sceneStatus.state;
  const placedHere=settled&&(largeScreen(panel.type)?side==='right'&&sceneStatus.state==='ceiling':panelSides(sceneStatus.state).includes(side));
  const spec=placedHere?sideTargets(side,panel,geometry.logical.width,geometry.logical.height):null;
  if(!spec){clear();return;}
  const {targets,width,height}=spec,{rect}=geometry;
  // Small screens shrink a painted control below a comfortable touch size; grow its hit area, not its look.
  const px=Math.max(.05,$('scene-frame').clientWidth*rect.width/width),MIN_TOUCH=FULL?48:30;
  const hit=target=>{
    const w=Math.max(target.w,MIN_TOUCH/px),h=Math.max(target.h,MIN_TOUCH/px),bounds=target.within||{x:0,y:0,w:width,h:height};
    const x=Math.min(Math.max(target.x+target.w/2-w/2,bounds.x),bounds.x+bounds.w-Math.min(w,bounds.w)),y=Math.min(Math.max(target.y+target.h/2-h/2,bounds.y),bounds.y+bounds.h-Math.min(h,bounds.h));
    return {x,y,w:Math.min(w,bounds.w),h:Math.min(h,bounds.h)};
  };
  const placed=targets.map(target=>({target,box:hit(target)}));
  const key=JSON.stringify([panel.type,panel.id||'',placed.map(({target,box})=>[target.id,target.label,Math.round(box.x),Math.round(box.y),Math.round(box.w),Math.round(box.h)]),[rect.left,rect.top,rect.width,rect.height].map(v=>Math.round(v*1000))]);
  if(key===(side==='right'?touchKey:touchKeyLeft)&&!layer.hidden)return;
  if(side==='right')touchKey=key;else touchKeyLeft=key;
  const focused=document.activeElement?.dataset?.touchId;
  layer.hidden=false;
  Object.assign(layer.style,{left:rect.left*100+'%',top:rect.top*100+'%',width:rect.width*100+'%',height:rect.height*100+'%'});
  layer.replaceChildren(...placed.map(({target,box})=>{
    const button=document.createElement('button');button.type='button';button.className='touch-target';button.dataset.touchId=target.id;button.setAttribute('aria-label',target.label);
    Object.assign(button.style,{left:box.x/width*100+'%',top:box.y/height*100+'%',width:box.w/width*100+'%',height:box.h/height*100+'%'});
    button.addEventListener('click',()=>void tapTarget(target,side));return button;
  }));
  if(focused)layer.querySelector(`[data-touch-id="${CSS.escape(focused)}"]`)?.focus({preventScroll:true});
}
/** A tap on a regular panel's own control. Only what MERLIN really supports is ever drawn. */
async function panelTap(target,side,panel){
  if(target.id==='close'){changeLayout(()=>orchestration.dismiss(side));return;}
  if(panel.type==='timer'){
    // One tap: a cancelled timer is cleared straight away instead of waiting for a second "Dismiss".
    const timer=snapshot.timers.find(t=>t.id===panel.id);if(!timer)return;await changeTimer(timer);
    const after=snapshot.timers.find(t=>t.id===panel.id);if(target.id==='cancel'&&after&&after.status!=='running')await changeTimer(after);return;
  }
  if(panel.type==='music'){await musicControl(target.id==='toggle'?(spotify.playback?.is_playing?'pause':'play'):target.id);return;}
  if(['lights','oven','speaker'].includes(panel.type))await deviceToggle(panel);
}
/** The same rules, hub and code-written receipt as a spoken request. The panel shows what the service reported. */
async function deviceToggle(panel){
  if(!['on','off'].includes(panel.status))return;
  const connector=String(panel.id||'').split(':')[0];
  const pending={...panel,status:'pending'};orchestration.remember(pending);orchestration.show(orchestration.view.destination,orchestration.view.label);
  try{
    const data=await api('/api/home/control',{request_id:crypto.randomUUID(),device:panel.label,action:panel.status==='on'?'turn_off':'turn_on',...(connector?{connector}:{})});
    orchestration.remember(data.card||{...panel,status:'error'});
    if(!data.ok)notice(data.message);
  }catch(error){orchestration.remember({...panel,status:'error'});notice(error.message);}
  orchestration.show(orchestration.view.destination,orchestration.view.label);
}
/** The person's own tap is the only thing that starts Spotify; the spoken request only put the button up. */
async function playOffer(){
  const panel=activePanels.right;if(panel?.type!=='music-offer'||offerUi.status==='starting')return;
  offerUi={status:'starting'};touchKey='';refreshConnections();$('touch-status').textContent=playOfferDescription(livePanel(panel));
  try{
    const device=$('spotify-device').value;
    const result=await api('/api/spotify/control',{request_id:crypto.randomUUID(),action:'play',query:panel.query||panel.title,type:'playlist',...(device?{device_id:device}:{})});
    if(result.status==='choice_required')throw new Error(`Choose “${panel.title}” or a device in the Spotify panel.`);
    offerUi={status:'playing'};touchKey='';refreshConnections();$('touch-status').textContent=playOfferDescription(livePanel(panel));
    await refreshMusic().catch(()=>{});
    // A moment on "Enjoy your workout!", then the screens go back up and the music card takes over.
    setTimeout(()=>{if(activePanels.right===panel&&offerUi.status==='playing')changeLayout(()=>orchestration.dismiss());},2500);
  }catch(error){offerUi={status:'error',notice:error.message||'That didn’t start. Tap to try again.'};touchKey='';refreshConnections();$('touch-status').textContent=playOfferDescription(livePanel(panel));}
}
async function tapTarget(target,side='right'){
  const panel=activePanels[side];
  if(panel&&!largeScreen(panel.type)){await panelTap(target,side,panel);return;}
  if(target.action==='close'){changeLayout(()=>orchestration.dismiss('right'));return;}
  if(activePanels.right?.type==='music-offer'){if(target.action==='play')await playOffer();return;}
  const geometry=character?.screenGeometry?.('right');if(!geometry||activePanels.right?.type!=='connections')return;
  const pages=pageCount(livePanel(activePanels.right),geometry.logical.width,geometry.logical.height);
  const {ui,effect}=applyAction(connectionsUi,target,{pages});connectionsUi=ui;touchKey='';
  refreshConnections();announceConnections();
  if(!effect)return;
  if(effect.type==='open'){
    // A normal new tab: nothing here waits for it, so the companion keeps running while the household sets things up.
    window.open(effect.url,'_blank','noopener,noreferrer');
    if(effect.name){connectionsUi={...connectionsUi,notice:`Opened the ${effect.name} setup page in a new tab.`,announce:`Opened the ${effect.name} setup page in a new tab. If nothing opened, visit /connections/ in a browser on this computer.`};touchKey='';refreshConnections();announceConnections();}
    return;
  }
  if(connectionsBusy)return;connectionsBusy=true;
  connectionsUi={...connectionsUi,busy:effect.type};touchKey='';refreshConnections();
  try{
    // The server checks the real service (verify) or revokes and forgets its credentials (disconnect). Nothing is assumed.
    const data=await api(`/api/connectors/${encodeURIComponent(effect.id)}/${effect.type}`,{});
    snapshot={...snapshot,connectors:[...(snapshot.connectors||[]).filter(item=>item.id!==data.id),connectorSummary(data)]};
    if(effect.type==='disconnect'){
      if(effect.id==='spotify')acceptMusic({connected:false});
      connectionsUi={...connectionsUi,notice:`Disconnected ${effect.name}.`,announce:data.message||`Disconnected ${effect.name}.`};
    }else connectionsUi={...connectionsUi,notice:data.status==='connected'?`${effect.name} is connected and verified.`:`${effect.name}: ${data.detail||'check the connection.'}`};
  }catch(error){
    connectionsUi={...connectionsUi,notice:error.status===401?`${effect.name} did not accept the saved credentials. Reconnect it on the Connection Center page.`:error.message||'That didn’t finish. Try again.'};
    void pollState();
  }
  finally{connectionsBusy=false;connectionsUi={...connectionsUi,busy:''};touchKey='';refreshConnections();announceConnections();}
}
function toggleActivity(open){$('activity').hidden=!open;$('activity-toggle').setAttribute('aria-expanded',String(open));if(open&&innerWidth<=720)$('activity').scrollIntoView({behavior:motionQuery.matches?'auto':'smooth',block:'start'});}
$('activity-toggle').addEventListener('click',()=>toggleActivity($('activity').hidden));$('activity-close').addEventListener('click',()=>{toggleActivity(false);$('activity-toggle').focus();});
$('chat-form').addEventListener('submit',event=>{event.preventDefault();void submit($('message').value.trim());});
$('message').addEventListener('focus',()=>{if(!turnId&&!voice.active){invalidate();orchestration.listening({typed:true});}});
$('message').addEventListener('blur',()=>{if(orchestration.phase==='listening'&&!voice.active&&!turnId)orchestration.followup();});
$('message').addEventListener('input',()=>{$('send').textContent=pendingRetry?.message===$('message').value.trim()?'Retry':'Send';});
$('microphone').addEventListener('click',async()=>{notice();if(voice.active){invalidate();voice.stop();return;}invalidate();if($('acknowledgments').checked)void unlockAudioPlayback($('ack-audio'));try{await voice.start({sessionId,timeZone});}catch(error){notice(error.message);$('voice-troubleshooting').hidden=false;}});
/** The home display listens for "MERLIN" on its own. One tap is needed only when the browser requires a gesture for sound. */
function audioUnlocked(){try{const probe=new AudioContext(),running=probe.state==='running';void probe.close().catch(()=>{});return running;}catch{return false;}}
// No message: the browser only needs one tap for sound, so the whole screen is the button. A real microphone
// problem is a smaller notice that leaves MERLIN's panels usable.
function showStart(message=''){$('full-start-text').textContent=message?`${message} Tap to try again.`:'Tap to start MERLIN';$('full-start').dataset.variant=message?'notice':'start';$('full-start').hidden=false;}
async function startFullVoice({gesture=false}={}){
  if(!FULL||micMuted||voice.active||document.visibilityState==='hidden')return;
  if(!gesture&&!audioUnlocked()){showStart();return;}
  $('full-start').hidden=true;void unlockAudioPlayback($('ack-audio'));void unlockAudioPlayback($('typed-audio'));
  try{await voice.start({sessionId,timeZone});}catch(error){showStart(error.message);}
}
/** The microphone stays visible and in the household's hands: one big tap mutes or unmutes it. */
function renderFullMic(state=voice.state){
  const button=$('full-mic');button.hidden=!FULL;button.setAttribute('aria-pressed',String(micMuted));
  button.setAttribute('aria-label',micMuted?'Microphone muted. Tap to turn it back on.':voice.active?'Microphone on. Tap to mute.':'Microphone off. Tap to turn it on.');
  button.dataset.hearing=String(['listening','transcribing'].includes(state));
}
if(FULL){
  $('full-start').addEventListener('click',()=>{micMuted=false;void startFullVoice({gesture:true});});
  $('full-mic').addEventListener('click',()=>{if(voice.active){micMuted=true;invalidate();voice.stop('Microphone muted.');}else{micMuted=false;void startFullVoice({gesture:true});}renderFullMic();});
  // Tapping MERLIN while he talks stops the reply, as the Stop button does elsewhere.
  $('scene').addEventListener('click',()=>{if(!$('stop').hidden)$('stop').click();});
  renderFullMic('off');void startFullVoice();
  // Tapping a floating card brings out its full panel, where the large controls are.
  $('scene-frame').addEventListener('click',event=>{
    const card=event.target.closest?.('.floating-overlay');if(!card||event.target.closest('.floating-action'))return;
    const id=card.dataset.overlayId||'';
    if(id.startsWith('timer:')){const timer=snapshot.timers.find(t=>t.id===id.slice(6));if(timer)orchestration.inspect(timerPanel(timer,Date.now()+serverOffset));}
    else if(id.startsWith('music:'))orchestration.inspect(musicPanel(spotify));
  });
}
$('stop').addEventListener('click',()=>{invalidate();voice.interrupt();if(voice.active)orchestration.listening();else orchestration.followup();notice('Reply stopped. Completed actions are still in Activity.');});
$('camera-allow').addEventListener('click',()=>{hideConsent();void submit('Yes, turn on the camera.');});
$('camera-decline').addEventListener('click',()=>{hideConsent();void submit('No, leave the camera off.');});
$('camera-close').addEventListener('click',()=>{if(!cameraCapture)return;cameraCapture.closed=true;cameraCapture.controller.abort();});
cameraMedia()?.addEventListener?.('devicechange',()=>void reportCamera());
$('close-panel').addEventListener('click',()=>changeLayout(()=>orchestration.dismiss()));$('reload-scene').addEventListener('click',()=>location.reload());
for(const button of document.querySelectorAll('[data-service]'))button.addEventListener('click',()=>{const type=button.dataset.service;if(['lights','oven','connections'].includes(type)){openConnections({category:type==='lights'?'lights':type==='oven'?'appliances':'all'});return;}orchestration.inspect(type==='music'?musicPanel(spotify):pendingPanel(type,'offline'));if(type!=='music')notice(type==='schedule'?'Schedules aren’t available yet.':'This home service isn’t connected yet.');});
$('previous').addEventListener('click',()=>musicControl('previous'));$('next').addEventListener('click',()=>musicControl('next'));$('play-pause').addEventListener('click',()=>musicControl(spotify.playback?.is_playing?'pause':'play'));$('spotify-device').addEventListener('change',renderMusic);$('refresh-music').addEventListener('click',()=>refreshMusic().catch(()=>{}));
$('clear-conversation').addEventListener('click',async()=>{invalidate();voice.stop();try{await api('/api/session/reset',{session_id:sessionId});$('heard').hidden=true;$('reply').textContent='Ready for a fresh conversation.';$('actions').replaceChildren();$('actions-empty').hidden=false;$('sources').hidden=true;pendingRetry=null;orchestration.standby();notice('This conversation was cleared. Your timers and panels are still here.');}catch(error){notice(error.message);}});
$('read-aloud').addEventListener('change',()=>{try{localStorage.setItem('merlin-read-aloud',String($('read-aloud').checked));}catch{}if(!$('read-aloud').checked){acknowledgments.cancel({resume:true});stopTyped();if(turnId&&voice.active)voice.interrupt();}else void unlockAudioPlayback($('typed-audio'));});
// Only this preference is remembered: no request content or playback history.
$('acknowledgments').addEventListener('change',()=>{try{localStorage.setItem('merlin-acknowledgments',String($('acknowledgments').checked));}catch{}if($('acknowledgments').checked)void unlockAudioPlayback($('ack-audio'));else acknowledgments.cancel({resume:true});});
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
const ticker=setInterval(()=>{if(document.hidden)return;if(!floatingCount||!['idle','ambient'].includes(orchestration.phase))orchestration.tick();countdowns();syncFloatingActivities();void drainAlerts();if(orchestration.phase==='speaking'||orchestration.acknowledging)character?.setSpeaking(.65);},500);
const statePoll=setInterval(()=>{if(document.visibilityState!=='hidden')void pollState();},2000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){invalidate();voice.stop();orchestration.standby();}else{void pollState();if(FULL)void startFullVoice();}});
window.addEventListener('pagehide',()=>{destroyed=true;invalidate();voice.destroy();floatingOverlays?.destroy();character?.destroy();clearInterval(ticker);clearInterval(statePoll);},{once:true});
void pollState();
createCharacter({canvas:$('scene'),stage:$('scene-frame'),touchPanels:FULL,onStatus:info=>{
  if(info?.message)$('loading').textContent=info.message;
  if(info?.state){sceneStatus=info;Object.assign($('stage').dataset,{characterState:info.state,characterDesired:info.desired||'',characterClip:info.clip||'',motionPhase:info.phase||''});if(character){updateControlVisibility();syncFloatingActivities();}}
},onError:()=>{$('scene-error').hidden=false;}}).then(runtime=>{character=runtime;floatingOverlays=new SceneOverlays($('scene-frame'),{clock:runtime,presentation:'companion'});$('loading').hidden=true;lastDestination='';renderView(orchestration.view);}).catch(()=>{$('loading').hidden=true;$('scene-error').hidden=false;});
