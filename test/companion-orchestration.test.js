import test from 'node:test';
import assert from 'node:assert/strict';
import {Orchestrator,IDLE_DELAY,FOLLOWUP_DELAY,timerPanel,musicPanel,pendingPanel,presentationLayout,panelSides} from '../public/companion/orchestrator.js';

function setup(options={}) {
  let now=0;const views=[];
  const o=new Orchestrator({...options,now:()=>now,render:view=>views.push(view)});
  return {o,views,advance(ms){now+=ms;o.tick();}};
}
const timer=(id='tea',extra={})=>({id,label:id+' timer',duration_seconds:300,ends_at:new Date(300000).toISOString(),status:'running',time_zone:'UTC',...extra});
const resultFor=(...timers)=>({reply:'The timers are set.',tool_events:timers.map(()=>({tool:'create_timer',status:'completed'})),presentation:timers.map(timer=>({type:'timer',...timer}))});
function complete(o,id,timers,extra={}) {o.begin(id);o.result(id,{...resultFor(...timers),...extra},{timers});o.reply(id);}
const ids=o=>Object.values(o.panels).filter(Boolean).map(panel=>panel.id).sort();

test('empty quiet scene alternates both walking directions and tossing without sweeping',()=>{
  const {o,advance}=setup();
  for(const activity of ['walk','walkReverse','toss','walk']){advance(activity==='walk'&&o.phase==='idle'?IDLE_DELAY:30000);assert.equal(o.view.destination,activity);}
  o.listening();advance(100000);assert.equal(o.view.destination,'face');
});
test('reduced motion suppresses casual movement but uses body thought for real progress',()=>{
  const {o,advance}=setup({reducedMotion:true});advance(90000);assert.equal(o.view.destination,'ready');
  o.begin('a');o.progress('a',[{stage:'tool_start',tool:'create_timer'}]);
  assert.equal(o.view.destination,'bodyThink');assert.equal(o.pending.panel.status,'pending');assert.deepEqual(ids(o),[]);assert.equal(o.bodyLayout,'ready');
});
test('short action receipt, speech, follow-up and quiet retain the same timer screen',()=>{
  const {o,advance}=setup();complete(o,'a',[timer()]);assert.equal(o.view.destination,'right');assert.equal(o.speechDestination,'right');
  o.speaking();o.followup();assert.equal(o.view.destination,'right');advance(FOLLOWUP_DELAY);assert.equal(o.view.destination,'right');
  advance(IDLE_DELAY+90000);assert.equal(o.view.destination,'right');assert.deepEqual(ids(o),['tea']);
  o.listening();assert.equal(o.view.destination,'face');o.standby();assert.equal(o.view.destination,'right');
});
test('general conversation temporarily covers panels and returns to their exact layout',()=>{
  const {o,advance}=setup();o.inspect(timerPanel(timer()));o.expandPanel('right');o.listening();o.begin('a');
  assert.equal(o.view.destination,'faceThink');o.result('a',{reply:'Hello.',tool_events:[]});o.reply('a');o.speaking();o.followup();
  assert.equal(o.view.destination,'face');assert.deepEqual(ids(o),['tea']);advance(FOLLOWUP_DELAY);assert.equal(o.view.destination,'ceiling');
});
test('long explanations, citations and explicit preference keep the reply in face mode',()=>{
  for(const extra of [{reply:'A useful detailed answer. '.repeat(20)},{sources:[{url:'https://example.com'}]},{tool_events:[{tool:'create_timer',status:'completed'},{tool:'web_search',status:'completed'}]}]){
    const {o}=setup();complete(o,'a',[timer()],extra);assert.equal(o.speechDestination,'face');assert.deepEqual(ids(o),['tea']);
  }
  const {o}=setup({actionRepliesInBody:false});complete(o,'a',[timer()]);assert.equal(o.speechDestination,'face');
});
test('two pinned timers survive pending, failed, interrupted and unrelated requests',()=>{
  const {o}=setup();o.restoreTimers([timer('one'),timer('two')]);o.begin('a');
  o.progress('a',[{stage:'tool_start',tool:'cancel_timer'},{stage:'tool_result',tool:'cancel_timer',ok:false}]);
  assert.deepEqual(ids(o),['one','two']);assert.equal(o.view.destination,'bothThink');assert.equal(o.pending.side,null);assert.equal(o.bodyLayout,'both');
  o.listening();assert.equal(o.pending,null);assert.deepEqual(ids(o),['one','two']);assert.equal(o.result('a',resultFor(timer('stale')),{timers:[timer('stale')]}),false);
  o.begin('b');o.result('b',{tool_events:[{tool:'create_timer',status:'failed'}]});o.reply('b');assert.equal(o.pending,null);assert.deepEqual(ids(o),['one','two']);
});
test('stale progress and replies cannot regain foreground after listening interruption',()=>{
  const {o}=setup();o.begin('old');o.listening();o.progress('old',[{stage:'tool_start',tool:'create_timer'}]);assert.equal(o.reply('old'),false);assert.equal(o.view.destination,'face');assert.equal(o.pending,null);
});
test('rapid confirmed result needs no progress polling and unknown outcomes create no ghost',()=>{
  const {o}=setup();complete(o,'a',[timer()]);assert.equal(o.panel.label,'tea timer');assert.equal(o.panel.seconds,300);
  const missing=setup().o;missing.begin('a');missing.result('a',{tool_events:[{tool:'create_timer',status:'completed'}]});
  assert.deepEqual(ids(missing),[]);assert.equal(missing.pending,null);missing.reply('a');assert.equal(missing.view.destination,'face');
  assert.equal(timerPanel(null).status,'unknown');assert.equal(pendingPanel('oven','offline').status,'offline');
});
test('third automatic result stays in Activity and explicit inspect replaces only focused slot',()=>{
  const {o}=setup();complete(o,'a',[timer('one'),timer('two'),timer('three')]);assert.deepEqual(ids(o),['one','two']);
  o.followup();const focus=o.focusSide,other=focus==='left'?'right':'left',retained=o.panels[other];
  o.inspect(timerPanel(timer('three')));assert.equal(o.panels[focus].id,'three');assert.equal(o.panels[other],retained);
});
test('create then cancel the same timer produces one final truthful panel',()=>{
  const {o}=setup(),stopped=timer('tea',{status:'cancelled'});o.begin('a');
  o.result('a',{tool_events:[{tool:'create_timer',status:'completed'},{tool:'cancel_timer',status:'completed'}],presentation:[{type:'timer',...stopped}]},{timers:[stopped]});
  assert.deepEqual(ids(o),['tea']);assert.equal(o.panel.status,'cancelled');assert.equal(o.bodyLayout,'right');
});
test('successful plus failed operation retains actual success without a failed duplicate panel',()=>{
  const {o}=setup();complete(o,'a',[timer()],{tool_events:[{tool:'create_timer',status:'completed'},{tool:'create_timer',status:'failed'}]});assert.deepEqual(ids(o),['tea']);assert.equal(o.panel.status,'running');assert.equal(o.panels.left,null);
});
test('routine records retain exact steps and deduplicate saved/read representations by identity',()=>{
  const {o}=setup();o.begin('a');o.result('a',{tool_events:[{tool:'routine_save',status:'completed'},{tool:'routine_read',status:'completed'}],presentation:[{type:'routine-saved',id:'one',label:'Tea',steps:['Start tea timer'],status:'saved'},{type:'routine',id:'one',label:'Tea',steps:['Start tea timer'],status:'ready'}]});
  assert.deepEqual(ids(o),['one']);assert.deepEqual(o.panel.steps,['Start tea timer']);assert.equal(o.panel.status,'ready');
});
test('multiple confirmed routines occupy distinct sides',()=>{
  const {o}=setup();o.begin('a');o.result('a',{tool_events:[{tool:'routine_save',status:'completed'},{tool:'routine_save',status:'completed'}],presentation:[{type:'routine-saved',id:'one',label:'Tea',steps:['Tea action'],status:'saved'},{type:'routine-saved',id:'two',label:'Coffee',steps:['Coffee action'],status:'saved'}]});assert.deepEqual(ids(o),['one','two']);assert.deepEqual(o.panels.left.steps,['Coffee action']);
});
test('selective paired dismissal selects seated survivor and only explicit close marks dismissal',()=>{
  const {o}=setup();o.restoreTimers([timer('one'),timer('two')]);o.dismiss('right');
  assert.equal(o.bodyLayout,'seatedLeft');assert.equal(o.view.destination,'seatedLeft');assert.equal(o.view.dismiss,true);assert.deepEqual(ids(o),['two']);
  o.begin('a');assert.equal(o.view.destination,'seatedLeftThink');assert.equal(o.view.dismiss,false);o.listening();o.standby();assert.equal(o.view.destination,'seatedLeft');o.dismiss('left');assert.equal(o.bodyLayout,'ready');assert.equal(o.view.dismiss,true);
});
test('closing a panel during conversation retains current turn and speech ownership',()=>{
  const {o}=setup({actionRepliesInBody:false});complete(o,'a',[timer()]);o.speaking();o.dismiss('right');assert.equal(o.view.destination,'face');assert.equal(o.phase,'speaking');assert.equal(o.turn,'a');assert.equal(o.speechDestination,'face');assert.equal(o.panel,null);
});
test('enlarge and dock move one identity and refuse to cover a second open panel',()=>{
  const {o}=setup();o.inspect(timerPanel(timer()));const panel=o.panel;assert.equal(o.dockPanel('left'),true);assert.equal(o.panels.left,panel);assert.equal(o.panels.right,null);
  assert.equal(o.expandPanel('left'),true);assert.equal(o.bodyLayout,'ceiling');assert.equal(o.panels.right,panel);assert.equal(o.panels.left,null);
  o.begin('a');assert.equal(o.view.destination,'ceilingThink');o.listening();o.standby();assert.equal(o.view.destination,'ceiling');
  o.inspect(timerPanel(timer('two')));assert.equal(o.bodyLayout,'both');assert.equal(o.expandPanel('right'),false);assert.equal(o.dockPanel('left'),false);assert.deepEqual(ids(o),['tea','two']);
});
test('timer expiry defers during conversation, updates existing side and never evicts other pins',()=>{
  const {o}=setup();o.restoreTimers([timer('one'),timer('two')]);o.listening();assert.equal(o.timerFinished(timer('one',{status:'completed'})),false);
  o.standby();assert.equal(o.timerFinished(timer('one',{status:'completed'})),true);assert.equal(o.panels.right.status,'done');assert.deepEqual(ids(o),['one','two']);
  assert.equal(o.timerFinished(timer('third',{status:'completed'})),true);assert.deepEqual(ids(o),['one','two']);assert.equal(o.speechDestination,'both');
});
test('one-time restoration skips completed records and never repins explicitly closed timers',()=>{
  const {o,views}=setup();assert.equal(o.restoreTimers([timer('done',{status:'completed'}),timer('one'),timer('two'),timer('three')]),true);assert.deepEqual(ids(o),['one','two']);assert.equal(o.view.destination,'both');
  o.dismiss('right');const count=views.length;assert.equal(o.restoreTimers([timer('one'),timer('two')]),false);assert.equal(views.length,count);assert.deepEqual(ids(o),['two']);
});
test('snapshots update/remove existing records without duplicates, face navigation, or dismissal animation',()=>{
  const {o,views}=setup();o.restoreTimers([timer('one'),timer('two')]);o.listening();const count=views.length;assert.equal(o.syncTimers([timer('one'),timer('two')]),false);assert.equal(views.length,count);
  assert.equal(o.syncTimers([timer('two',{status:'completed'})]),true);assert.equal(o.view.destination,'face');assert.equal(o.bodyLayout,'seatedLeft');assert.equal(o.panels.left.status,'done');assert.equal(o.view.dismiss,false);
  o.standby();assert.equal(o.view.destination,'seatedLeft');assert.equal(o.syncTimers([]),true);assert.equal(o.view.destination,'ready');
});
test('restore during a conversation preserves foreground ownership',()=>{
  const {o}=setup();o.listening();o.begin('a');o.restoreTimers([timer()]);assert.equal(o.view.destination,'faceThink');assert.equal(o.turn,'a');assert.equal(o.bodyLayout,'right');
});
test('speech preparation freezes idle without claiming playback and pins exact target',()=>{
  const {o,advance}=setup();o.inspect(timerPanel(timer()));o.expandPanel();o.prepareSpeech({destination:'ceiling'});advance(90000);assert.equal(o.phase,'reply');assert.equal(o.view.label,'MERLIN');
  o.speaking({destination:'ceiling'});o.followup({external:true});advance(15000);assert.equal(o.view.destination,'ceiling');assert.equal(o.speechDestination,'ceiling');o.standby();assert.equal(o.view.destination,'ceiling');
});
test('contextual screen/thought layouts expose physical controls and face descendants hide them',()=>{
  for(const [destination,sides] of [['left',['left']],['right',['right']],['both',['left','right']],['seatedLeft',['left']],['seatedRight',['right']],['ceiling',['right']]]){
    for(const mode of [destination,destination+'Think']){assert.deepEqual(panelSides(mode),sides);assert.equal(presentationLayout({destination:mode,panels:{left:timer(),right:timer()},focusSide:'right'}).showControls,true);}
  }
  for(const destination of ['face','faceThink','search','camera'])assert.equal(presentationLayout({destination,panels:{left:timer(),right:timer()}}).showControls,false);
  assert.deepEqual(presentationLayout({destination:'bothThink',panels:{left:timer(),right:timer()},focusSide:'left'},['ready','face','left','right']),{destination:'left',showControls:true});
});
test('validated search and quiet learning preserve records and errors clear transient work',()=>{
  const {o}=setup();o.restoreTimers([timer()]);o.begin('a');o.progress('a',[{stage:'search_ready'}]);assert.equal(o.view.destination,'search');o.progress('a',[{stage:'learning_error'}]);assert.equal(o.view.destination,'search');assert.deepEqual(ids(o),['tea']);o.error('Unavailable');assert.equal(o.pending,null);
});
test('music only dances from actual playback with no retained panels',()=>{
  const {o,advance}=setup();o.musicPlaying=true;advance(IDLE_DELAY);assert.equal(o.view.destination,'dance');o.inspect(timerPanel(timer()));o.standby();advance(90000);assert.equal(o.view.destination,'right');
  assert.equal(musicPanel({connected:false}).status,'offline');assert.equal(musicPanel({connected:true,playback:null}).status,'empty');assert.equal(musicPanel({connected:true,playback:{is_playing:false,track:{name:'Synthetic track'}}}).status,'paused');
});
test('typed composition remains distinct from microphone listening',()=>{
  const {o}=setup();o.listening({typed:true});assert.equal(o.view.label,'Ready when you are');o.listening();assert.equal(o.view.label,'I’m listening');
});
test('repeated service inspection updates its singleton screen without duplicating or replacing another item',()=>{
  for(const type of ['lights','oven','schedule','music']){
    const {o}=setup();o.inspect(pendingPanel(type,'offline'));const side=o.focusSide;
    o.inspect(timerPanel(timer()));o.inspect(pendingPanel(type,'offline'));
    assert.equal(o.focusSide,side);assert.equal(o.panels[side].type,type);assert.deepEqual(ids(o).filter(Boolean),['tea']);
    assert.equal(Object.values(o.panels).filter(panel=>panel?.type===type).length,1);
  }
  const {o}=setup();o.inspect(pendingPanel('timer','unknown'));o.inspect(pendingPanel('timer','unknown'));
  assert.equal(Object.values(o.panels).filter(Boolean).length,2);
});
