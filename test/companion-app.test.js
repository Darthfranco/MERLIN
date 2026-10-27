import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import * as orchestration from '../public/companion/orchestrator.js';
import {floatingActivityPlan} from '../public/companion/floating-activities.js';
import {TimerAlertQueue} from '../public/companion/timer-alerts.js';
import {AnimationMixer,AnimationClip,Object3D} from '../assets/merlin-character/viewer/vendor/three/build/three.module.min.js';
import {MotionController} from '../assets/merlin-character/viewer/motion.js';
import {createCharacterDriver} from '../assets/merlin-character/viewer/character.js';

const flush=()=>new Promise(setImmediate);
const timer=(id='one')=>({id,label:'Timer',duration_seconds:300,ends_at:new Date(Date.now()+300000).toISOString(),status:'running',time_zone:'UTC'});
const receipt=t=>({reply:'Your timer is running.',tool_events:[{tool:'create_timer',status:'completed',message:'Timer started.'}],presentation:[{type:'timer',...t}],timers:[t]});
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}

async function fixture(t,{timers=[],chatResult,tts,realDriver=false,musicSnapshot={connected:false}}={}){
  class Element{
    constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.hidden=false;this.handlers=new Map();this.attributes={};this.value='';this.textContent='';this.src='';this.currentSrc='';this.paused=true;this.plays=0;}
    addEventListener(name,fn,{signal}={}){if(signal?.aborted)return;const list=this.handlers.get(name)||[];list.push(fn);this.handlers.set(name,list);signal?.addEventListener('abort',()=>this.removeEventListener(name,fn),{once:true});}
    removeEventListener(name,fn){this.handlers.set(name,(this.handlers.get(name)||[]).filter(item=>item!==fn));}
    async dispatch(name,event={}){return Promise.all((this.handlers.get(name)||[]).map(fn=>fn(event)));}
    setAttribute(name,value){this.attributes[name]=value;}
    removeAttribute(name){if(name==='src')this.src='';else delete this.attributes[name];}
    append(...nodes){this.children.push(...nodes);}
    replaceChildren(...nodes){this.children=[...nodes];}
    querySelector(selector){return this.querySelectorAll(selector)[0]||new Element(selector);}
    querySelectorAll(selector){const descendants=this.children.flatMap(node=>[node,...node.querySelectorAll('*')]);return descendants.filter(node=>selector==='*'||node.tag===selector||selector==='[data-timer-id]'&&node.dataset.timerId);}
    focus(){document.activeElement=this;}
    scrollIntoView(){}
    play(){if(this.blockPlayback)return Promise.reject(new Error('Autoplay blocked'));this.currentSrc=this.src;this.paused=false;this.ended=false;this.plays++;void this.dispatch('play');return Promise.resolve();}
    pause(){if(this.paused)return;this.paused=true;void this.dispatch('pause');}
    load(){this.currentSrc=this.src;}
  }
  const elements=new Map(),element=id=>{if(!elements.has(id))elements.set(id,new Element(id.includes('audio')?'audio':'div'));return elements.get(id);};
  const document=new Element();document.visibilityState='visible';document.hidden=false;document.getElementById=element;document.createElement=tag=>new Element(tag);document.querySelectorAll=()=>[];
  element('microphone').append(new Element('span'));element('activity').hidden=true;
  const window=new Element(),calls=[],requests=[],waiters=new Set(),physical={left:null,right:null};let notify;
  const manifest=JSON.parse(await readFile(new URL('../assets/merlin-character/states.json',import.meta.url),'utf8'));
  let controller;
  let runtime={state:'ready',desired:'ready',phase:'idle',auto:true,capabilities:{states:Object.keys(manifest.states)},
    go(destination,options={}){calls.push({destination,options});this.departure=this.state;this.desired=destination;this.phase='transition';notify?.({state:this.state,desired:destination,phase:this.phase,clip:'Route'});for(const waiter of [...waiters])if(waiter.destination!==destination){waiters.delete(waiter);waiter.resolve(false);}if(this.auto||options.urgent)this.settle();},
    settle(){if(this.departure==='ceiling'&&this.desired==='left')physical.left=physical.right;this.state=this.desired;this.phase='idle';notify?.({state:this.state,desired:this.desired,phase:'idle',clip:this.state+'Idle'});for(const waiter of [...waiters]){waiters.delete(waiter);waiter.resolve(waiter.destination===this.state);}},
    whenSettled(destination,signal){if(signal?.aborted||destination!==this.desired)return Promise.resolve(false);if(this.phase==='idle')return Promise.resolve(this.state===destination);return new Promise(resolve=>{const waiter={destination,resolve};waiters.add(waiter);signal?.addEventListener('abort',()=>{waiters.delete(waiter);resolve(false);},{once:true});});},
    showPanel(type,data,side){physical[side]={type,data};},clearPanel(side){physical[side]=null;},setSpeaking(value){this.speaking=value;},setListening(value){this.listening=value;},destroy(){for(const waiter of waiters)waiter.resolve(false);waiters.clear();},
  };
  if(realDriver){
    const clips=Object.entries(manifest.clips).map(([name,meta])=>new AnimationClip(name,(meta.frames-1)/manifest.fps,[]));
    controller=new MotionController(new AnimationMixer(new Object3D()),clips,manifest,()=>runtime?.motionChanged?.());
    const screens=Object.fromEntries(['left','right'].map(side=>[side,{version:0,draw(){this.version++;},tick(){},copyFrom(){this.version++;},reset(){this.version++;},setAspect(){}}]));
    runtime=createCharacterDriver({controller,screens,onStatus:status=>notify?.(status)});
    const go=runtime.go;runtime.go=(destination,options)=>{calls.push({destination,options});return go(destination,options);};
  }
  class Voice{
    constructor(options){this.options=options;this.active=false;this.state='off';this.readouts=[];}
    endConversation(){this.sleeps=(this.sleeps||0)+1;}interrupt(){this.interrupted=true;}stop(){this.active=false;}destroy(){this.stop();}unlockPlayback(){return Promise.resolve(true);}announceTimer(id){this.timer=id;return true;}
    async speakReply(id){this.readouts.push(id);const utteranceId='typed-'+id;const allowed=await this.options.playbackGate({requestId:id,revision:10,utteranceId,presentationMode:'face'});if(allowed)this.options.onEvent({type:'playback',playing:true,utteranceId,revision:10,presentationMode:'face'});return allowed;}
  }
  let urlCount=0;class ObjectURL extends URL{static createObjectURL(){return 'blob:app-'+(++urlCount);}static revokeObjectURL(){}}
  const storage={getItem(){return null;},setItem(){}};
  class SceneOverlays{
    constructor(){this.cards=new Map();}
    setPresentation(mode){this.mode=mode;}
    show(type,data,{id}){this.cards.set(id,{type,data});}
    hide(id){this.cards.delete(id);}
    destroy(){this.cards.clear();}
  }
  const context=createContext({...orchestration,floatingActivityPlan,SceneOverlays,TimerAlertQueue,document,window,URL:ObjectURL,Blob,AbortController,AbortSignal,Date,Intl,crypto:{randomUUID},sessionStorage:storage,localStorage:storage,innerWidth:1200,location:{reload(){}},
    CompanionVoiceClient:Voice,unlockAudioPlayback:()=>Promise.resolve(true),formatDuration:seconds=>String(seconds),
    createCharacter:async options=>{notify=options.onStatus;notify({state:'ready',desired:'ready',phase:'idle',clip:'ReadyIdle'});return runtime;},
    matchMedia:()=>({matches:false,addEventListener(){}}),Option:class extends Element{constructor(text,value){super('option');this.textContent=text;this.value=value;}},
    setInterval:()=>0,clearInterval(){},setTimeout,clearTimeout,
    fetch:async(path,options={})=>{requests.push({path,options});if(path.includes('/speak')||path.includes('/timer-speech')){if(tts)await tts.promise;return {ok:true,blob:async()=>new Blob(['synthetic audio'])};}const data=path==='/api/companion/state'?{configured:true,timers,services:{spotify:{connected:musicSnapshot.connected}}}:path==='/api/spotify?refresh=1'?musicSnapshot:path==='/api/chat'?chatResult||{reply:'Hello.',tool_events:[],timers}:path.includes('/progress?')?{status:'complete',events:[]}:{};return {ok:true,json:async()=>data};},
  });
  const source=await readFile(new URL('../public/companion/app.js',import.meta.url),'utf8');
  runInContext(source.replace(/^import .*;\n/gm,''),context);
  const run=code=>runInContext(code,context);
  await flush();await flush();
  t.after(()=>{run('destroyed=true;invalidate();sceneCleanup?.abort();voice.destroy();character?.destroy();');});
  return {element,document,run,runtime,calls,requests,physical,setMusicSnapshot(value){musicSnapshot=value;},async advance(seconds=30){for(let i=0;i<seconds*60;i++)controller.update(1/60);await flush();},get voice(){return run('voice');},get o(){return run('orchestration');},async until(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Expected app state did not arrive.');}};
}

test('actual app startup restores running timers and clearing conversation keeps both identities',async t=>{
  const a=timer('a'),b=timer('b'),h=await fixture(t,{timers:[a,b]});
  assert.equal(h.runtime.desired,'ready');assert.equal(h.run('floatingOverlays.cards.size'),2);assert.equal(h.physical.right,null);assert.equal(h.physical.left,null);
  await h.element('clear-conversation').dispatch('click');await flush();
  assert.equal(h.o.panels.right.id,'a');assert.equal(h.o.panels.left.id,'b');assert.equal(h.runtime.desired,'ready');
  assert.equal(h.requests.some(request=>request.path.includes('/api/timers/')),false);
});

test('selective dismissal keeps outgoing textures until its authored transition settles',async t=>{
  const h=await fixture(t);h.run(`orchestration.inspect(timerPanel(${JSON.stringify(timer('a'))}));orchestration.inspect(timerPanel(${JSON.stringify(timer('b'))}));`);h.runtime.auto=false;
  h.run("changeLayout(()=>orchestration.dismiss('left'))");
  assert.equal(h.runtime.desired,'seatedRight');assert.equal(h.calls.at(-1).options.dismiss,true);
  assert.equal(h.physical.left.data().id,'b','the disappearing card stays intact during its exit');
  assert.equal(h.element('action-controls').hidden,true);
  h.runtime.settle();await flush();
  assert.equal(h.physical.left,null);assert.equal(h.physical.right.data().id,'a');assert.equal(h.element('action-controls').hidden,false);
});

test('ceiling docking moves the same live timer and control identity without clearing its source early',async t=>{
  const h=await fixture(t,{timers:[timer('a')]});
  h.run("changeLayout(()=>orchestration.expandPanel('right'))");await flush();assert.equal(h.runtime.state,'ceiling');
  h.runtime.auto=false;h.run("changeLayout(()=>orchestration.dockPanel('left'))");
  assert.equal(h.physical.right.data().id,'a');h.runtime.settle();await flush();
  assert.equal(h.physical.right,null);assert.equal(h.physical.left.data().id,'a');
  const group=h.element('action-controls').children[0];assert.equal(group.dataset.panelId,'a');assert.equal(group.dataset.panelSide,'left');
  h.run(`acceptSnapshot({timers:[${JSON.stringify({...timer('a'),status:'completed'})}]})`);await flush();
  assert.equal(h.physical.left.data().status,'done');assert.equal(h.o.panels.left.id,'a');
  h.run('orchestration.listening()');await flush();assert.equal(h.element('action-controls').hidden,true);assert.equal(h.physical.left.data().id,'a');
  h.run('orchestration.standby()');await flush();assert.equal(h.runtime.state,'left');assert.equal(h.physical.left.data().id,'a');
});

test('typed HTTP action speech begins only in its body destination and follows up there',async t=>{
  const a=timer('a'),h=await fixture(t,{chatResult:receipt(a)}),work=h.run("submit('Start a timer')");
  await h.until(()=>h.element('typed-audio').plays===1);
  assert.equal(h.runtime.state,'right');assert.equal(h.o.phase,'speaking');assert.equal(h.physical.right.data().id,'a');
  h.element('typed-audio').ended=true;await h.element('typed-audio').dispatch('ended');await work;
  assert.equal(h.o.phase,'followup');assert.equal(h.runtime.desired,'right');
  assert.equal(h.calls.some(call=>call.options.urgent),false);
});

test('typed wake-socket and ordinary voice action speech ignore default wire face metadata',async t=>{
  const a=timer('a'),h=await fixture(t,{chatResult:receipt(a)});h.voice.active=true;h.voice.state='wake';
  await h.run("submit('Start a timer')");assert.equal(h.voice.readouts.length,1);assert.equal(h.runtime.desired,'right');
  h.run("voiceEvent({type:'state',state:'listening',revision:20});voiceEvent({type:'state',state:'transcribing',revision:20})");
  h.run(`voiceEvent({type:'response',revision:20,requestId:'voice-a',response:${JSON.stringify(receipt(a))}})`);await h.run('completion');
  assert.equal(await h.voice.options.playbackGate({revision:20,utteranceId:'voice-clip',presentationMode:'face'}),true);
  h.voice.options.onEvent({type:'playback',playing:true,revision:20,utteranceId:'voice-clip',presentationMode:'face'});
  assert.equal(h.runtime.desired,'right');assert.equal(h.o.phase,'speaking');
});

test('new listening while typed audio is being generated cancels stale playback without clearing timers',async t=>{
  const a=timer('a'),tts=deferred(),h=await fixture(t,{chatResult:receipt(a),tts}),work=h.run("submit('Start a timer')");
  await h.until(()=>h.requests.some(request=>request.path==='/api/companion/speak'));
  h.run("voiceEvent({type:'state',state:'listening',revision:30})");tts.resolve();await work;await flush();
  assert.equal(h.element('typed-audio').plays,0);assert.equal(h.runtime.desired,'face');assert.equal(h.physical.right.data().id,'a');
  assert.equal(h.calls.at(-1).options.urgent,undefined,'capture starts without an ordinary pose snap');
});

test('blocked typed playback manually resumes in the pinned panel and cannot resume after Stop',async t=>{
  const a=timer('a'),h=await fixture(t,{chatResult:receipt(a)});h.element('typed-audio').blockPlayback=true;
  await h.run("submit('Start a timer')");assert.equal(h.element('typed-audio').hidden,false);
  h.run('orchestration.standby()');h.runtime.auto=false;h.element('typed-audio').blockPlayback=false;
  await h.element('typed-audio').play();await flush();
  assert.equal(h.runtime.desired,'right');
  await h.element('stop').dispatch('click');h.runtime.settle();await flush();
  assert.equal(h.element('typed-audio').src,'');assert.equal(h.element('typed-audio').paused,true);
});

test('automatic third timer alert speaks beside retained screens without replacing either timer',async t=>{
  const h=await fixture(t,{timers:[timer('a'),timer('b')]});
  h.run(`voiceEvent({type:'notification',revision:40,presentationMode:'body',response:{reply:'Another timer finished.',presentation:[${JSON.stringify({...timer('c'),status:'completed',type:'timer'})}]}})`);
  await h.run('completion');assert.equal(await h.voice.options.playbackGate({revision:40,utteranceId:'alert',presentationMode:'body'}),true);
  assert.equal(h.runtime.desired,'ready');assert.equal(h.o.panels.right.id,'a');assert.equal(h.o.panels.left.id,'b');
  h.run("voiceEvent({type:'interrupt',reason:'notification-ended',revision:41});voiceEvent({type:'state',state:'wake',revision:41})");
  assert.equal(h.runtime.desired,'ready');assert.equal(await h.voice.options.playbackGate({revision:41,utteranceId:'alert',presentationMode:'body'}),true,'manual fallback retains its original alert target');
});

test('closing a panel while HTTP or wake-socket speech is pending cannot restore the closed layout',async t=>{
  for(const socket of [false,true]){
    const a=timer('a'),tts=deferred(),h=await fixture(t,{chatResult:receipt(a),tts});
    if(socket){h.voice.active=true;h.voice.state='wake';const original=h.voice.speakReply.bind(h.voice);h.voice.speakReply=async id=>{h.voice.waiting=true;await tts.promise;return original(id);};}
    const work=h.run("submit('Start a timer')");
    await h.until(()=>socket?h.voice.waiting:h.requests.some(request=>request.path==='/api/companion/speak'));
    h.run("changeLayout(()=>orchestration.dismiss('right'))");assert.equal(h.runtime.desired,'ready');
    const afterClose=h.calls.length;tts.resolve();await work;await flush();
    assert.equal(h.element('typed-audio').plays,0);assert.equal(h.runtime.desired,'ready');
    assert.equal(h.o.panels.right,null);assert.equal(h.calls.slice(afterClose).some(call=>['right','face'].includes(call.destination)),false);
    assert.equal(h.voice.interrupted,undefined,'layout changes must not emit a follow-up-listening interrupt');
    assert.equal(h.requests.some(request=>request.path.includes('/api/timers/')),false,'closing a screen does not cancel its timer');
  }
});

test('actual app and driver return to an empty ready scene when snapshot removal deletes the final timer',async t=>{
  const a=timer('a'),b=timer('b'),h=await fixture(t,{timers:[a,b],realDriver:true});await h.advance();
  assert.equal(h.runtime.state,'ready');assert.equal(h.run('floatingOverlays.cards.size'),2);
  h.run(`acceptSnapshot({timers:[${JSON.stringify(b)}]})`);await h.advance();
  assert.equal(h.runtime.state,'seatedLeft');assert.equal(h.runtime.panels.left.id,'b');
  assert.equal(h.calls.at(-1).options.preservePanels,true,'a surviving record retains its physical context');
  h.run('acceptSnapshot({timers:[]})');await h.advance();
  assert.equal(h.runtime.state,'ready');assert.equal(h.runtime.desired,'ready');
  assert.equal(h.runtime.panels.left,null);assert.equal(h.runtime.panels.right,null);
  assert.equal(h.element('action-controls').hidden,true);
});


test('actual companion keeps live timer identities in the compact face rail and returns to floating body',async t=>{
  const a=timer('a'),b=timer('b'),c=timer('c'),h=await fixture(t,{timers:[a,b,c]});
  assert.equal(h.runtime.desired,'ready');assert.equal(h.run('floatingOverlays.cards.size'),3);
  h.run('orchestration.listening()');await flush();
  assert.equal(h.runtime.desired,'face');assert.equal(h.run('floatingOverlays.mode'),'face');
  assert.equal(h.run('floatingOverlays.cards.size'),3);assert.equal(h.element('action-controls').hidden,true);
  const before=h.run("floatingOverlays.cards.get('timer:a').data.remainingSeconds");
  h.run('serverOffset=2000;syncFloatingActivities()');
  assert.ok(h.run("floatingOverlays.cards.get('timer:a').data.remainingSeconds")<before);
  h.run('orchestration.standby()');await flush();
  assert.equal(h.runtime.desired,'ready');assert.equal(h.run('floatingOverlays.mode'),'body');
  assert.equal(h.run('floatingOverlays.cards.size'),3);
  h.run(`acceptSnapshot({timers:[${JSON.stringify({...a,status:'cancelled'})},${JSON.stringify({...b,status:'completed'})},${JSON.stringify(c)}]})`);await flush();
  assert.equal(h.run("floatingOverlays.cards.has('timer:a')"),false);
  assert.equal(h.run("floatingOverlays.cards.get('timer:b').data.status"),'finished');
  h.run('acceptSnapshot({timers:[]})');await flush();assert.equal(h.run('floatingOverlays.cards.size'),0);
});

test('timer plus verified music uses floating body and face with metadata confined to local presentation',async t=>{
  const h=await fixture(t,{timers:[timer('a')]});
  h.run(`spotify={connected:true,playback:{is_playing:true,track:{name:'Synthetic song',artists:['Synthetic artist']}}};refreshActivityPresentation()`);await flush();
  assert.equal(h.runtime.desired,'ready');assert.equal(h.run('floatingOverlays.cards.size'),2);
  assert.equal(h.run("floatingOverlays.cards.get('music:spotify').data.title"),'Synthetic song');
  h.run('orchestration.listening()');await flush();assert.equal(h.run('floatingOverlays.mode'),'face');
  assert.equal(h.requests.some(r=>r.options.body?.includes('Synthetic song')),false);
  h.run('spotify={connected:false};refreshActivityPresentation()');await flush();
  assert.equal(h.run("floatingOverlays.cards.has('music:spotify')"),false);assert.equal(h.run('floatingOverlays.cards.size'),1);
});

test('adding a second live timer uses a safe neutral-body route without deleting the logical first panel',async t=>{
  const a=timer('a'),b=timer('b'),h=await fixture(t,{timers:[a],realDriver:true});await h.advance();assert.equal(h.runtime.state,'right');
  h.run(`acceptSnapshot({timers:[${JSON.stringify(a)},${JSON.stringify(b)}]})`);
  assert.equal(h.runtime.desired,'ready');assert.equal(h.calls.at(-1).options.restorePanels,false);
  assert.equal(h.calls.at(-1).options.preservePanels,true);await h.advance();
  assert.equal(h.runtime.state,'ready');assert.equal(h.o.panels.right.id,'a');assert.equal(h.run('floatingOverlays.cards.size'),2);
  h.run('orchestration.listening()');await h.advance();assert.equal(h.runtime.state,'face');assert.equal(h.run('floatingOverlays.cards.size'),2);
});

test('retained music refreshes while floating and returns with current track and paused state',async t=>{
  const h=await fixture(t,{timers:[timer('a')]});
  h.setMusicSnapshot({connected:true,playback:{is_playing:true,track:{name:'Synthetic first song',artists:['Synthetic artist']}}});
  await h.run('refreshMusic()');h.run('orchestration.inspect(musicPanel(spotify))');await flush();
  assert.equal(h.runtime.desired,'ready');assert.equal(h.physical.left,null);assert.equal(h.physical.right,null);
  assert.equal(h.o.panels.left.type,'music');
  h.setMusicSnapshot({connected:true,playback:{is_playing:false,track:{name:'Synthetic next song',artists:['Synthetic artist']}}});
  await h.run('refreshMusic()');await flush();
  assert.equal(h.o.panels.left.title,'Synthetic next song');assert.equal(h.o.panels.left.status,'paused');
  assert.equal(h.o.view.panels.left.title,'Synthetic next song');assert.equal(h.run("floatingOverlays.cards.get('music:spotify').data.status"),'paused');
  const revision=h.run('sceneRevision');await h.run('refreshMusic()');assert.equal(h.run('sceneRevision'),revision,'unchanged playback does not rebuild the scene');
  h.run('acceptSnapshot({timers:[]})');await flush();
  assert.equal(h.runtime.desired,'seatedLeft');assert.equal(h.physical.left.data().title,'Synthetic next song');
  assert.equal(h.physical.left.data().status,'paused');assert.equal(h.run('floatingOverlays.cards.size'),0);
  assert.equal(h.requests.some(request=>request.options.body?.includes('Synthetic next song')),false);
});

test('connection polling reconciles concealed music before disconnected physical panels return',async t=>{
  const h=await fixture(t,{timers:[timer('a')]});
  h.setMusicSnapshot({connected:true,playback:{is_playing:true,track:{name:'Synthetic playing song',artists:[]}}});
  await h.run('refreshMusic()');h.run('orchestration.inspect(musicPanel(spotify))');await flush();
  assert.equal(h.runtime.desired,'ready');assert.equal(h.run('floatingOverlays.cards.size'),2);
  h.setMusicSnapshot({connected:false});await h.run('pollState()');await flush();
  assert.equal(h.o.panels.left.status,'offline');assert.equal(h.o.view.panels.left.status,'offline');
  assert.equal(h.physical.left.data().status,'offline');assert.equal(h.physical.left.data().title,undefined);
  assert.equal(h.run("floatingOverlays.cards.has('music:spotify')"),false);assert.equal(h.run('orchestration.musicPlaying'),false);
  h.run('acceptSnapshot({timers:[]})');await flush();
  assert.equal(h.runtime.desired,'seatedLeft');assert.equal(h.physical.left.data().status,'offline');
});
