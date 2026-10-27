/** Foreground presentation only. No device, memory, or model execution lives here. */
export const IDLE_DELAY = 20_000;
export const FOLLOWUP_DELAY = 10_000;
export const ACTION_HOLD = 400;
const idleActivities = ['walk', 'walkReverse', 'toss'];
export const toolPanel = tool => /^(create|cancel|list)_timer/.test(tool) ? 'timer'
  : tool?.startsWith('spotify_') ? 'music' : tool === 'routine_save' ? 'routine-saved'
    : ['routine_read', 'routine_use'].includes(tool) ? 'routine' : null;
const labels = {timer:'Your timer',music:'Spotify',lights:'Lights',oven:'Oven',schedule:'Schedules',routine:'Your routine','routine-saved':'Your routine'};
const surfaces = {left:['left'],right:['right'],both:['left','right'],seatedLeft:['left'],seatedRight:['right'],ceiling:['right']};
const faceStates = new Set(['face','faceThink','search','camera']);
export const panelSides = destination => [...(surfaces[destination?.replace(/Think$/, '')] || [])];
export const isFacePresentation = destination => faceStates.has(destination);
const identity = panel => panel?.id ? `${panel.type?.startsWith('routine')?'routine':panel.type}:${panel.id}` : ['music','lights','oven','schedule'].includes(panel?.type) ? panel.type : null;
const sameTimer = (a,b) => ['id','label','status','durationSeconds','endsAt','timeZone'].every(key=>a?.[key]===b?.[key]);
export function presentationLayout(view, states) {
  const available = new Set(states || ['ready','bodyThink','face','faceThink','search','camera','walk','walkReverse','toss','dance',...Object.keys(surfaces),...Object.keys(surfaces).map(state=>state+'Think')]);
  let destination = view.destination;
  if (!available.has(destination)) {
    const base=destination?.replace(/Think$/, '');
    destination = isFacePresentation(destination)&&available.has('face')?'face'
      : available.has(base)?base : panelSides(destination).length&&available.has(view.focusSide)?view.focusSide:'ready';
  }
  return {destination, showControls:panelSides(destination).some(side=>Boolean(view.panels?.[side]))};
}
export function pendingPanel(type, status = 'pending') { return {type,status,label:labels[type] || 'Your action',source:'live'}; }
export function timerPanel(timer, now = Date.now()) {
  if (!timer) return pendingPanel('timer', 'unknown');
  return {type:'timer',source:'live',id:timer.id,label:timer.label || 'Timer',
    status:timer.status === 'completed' ? 'done' : timer.status === 'cancelled' ? 'cancelled' : timer.status === 'running' ? 'running' : 'unknown',
    seconds:Math.max(0,Math.ceil((Date.parse(timer.ends_at)-now)/1000)),durationSeconds:timer.duration_seconds,
    endsAt:timer.ends_at,timeZone:timer.time_zone};
}
export function musicPanel(snapshot) {
  if (!snapshot?.connected) return pendingPanel('music','offline');
  const p=snapshot.playback;
  if (!p) return {type:'music',source:'live',status:'empty'};
  return {type:'music',source:'live',status:p.is_playing?'playing':'paused',title:p.track?.name || 'Spotify playback',
    artist:Array.isArray(p.track?.artists)?p.track.artists.join(', '):'',device:p.device?.name || '',
    elapsed:(p.progress_ms || 0)/1000,duration:(p.track?.duration_ms || 0)/1000};
}
export class Orchestrator {
  constructor({render=()=>{},now=()=>Date.now(),reducedMotion=false,actionRepliesInBody=true}={}) {
    this.render=render;this.now=now;this.reducedMotion=reducedMotion;this.actionRepliesInBody=actionRepliesInBody;this.epoch=0;this.idleIndex=0;
    this.phase='idle';this.deadline=now()+IDLE_DELAY;this.panel=null;this.panels={left:null,right:null};this.focusSide='right';this.turn=null;this.lastActionAt=0;
    this.bodyLayout='ready';this.speechDestination='face';this.pending=null;this.turnHadAction=false;this.restoredTimers=false;
    this.show('ready','Here when you need me');
  }
  show(destination,label,panel=this.panel,{dismiss=false}={}) {
    this.view={destination,label,panel,panels:{...this.panels},pending:this.pending,bodyLayout:this.bodyLayout,speechDestination:this.speechDestination,focusSide:this.focusSide,phase:this.phase,epoch:this.epoch,dismiss};
    this.render(this.view);return this.view;
  }
  refreshLayout({seated=false}={}) {
    const sides=['left','right'].filter(side=>this.panels[side]);
    if(!sides.includes(this.focusSide))this.focusSide=sides.includes('right')?'right':sides[0]||'right';
    this.panel=this.panels[this.focusSide];
    if(sides.length===2)this.bodyLayout='both';
    else if(!sides.length)this.bodyLayout='ready';
    else if(seated)this.bodyLayout=sides[0]==='left'?'seatedLeft':'seatedRight';
    else if(!panelSides(this.bodyLayout).includes(sides[0])||this.bodyLayout==='both')this.bodyLayout=sides[0];
  }
  remember(panel,side,{replace=false}={}) {
    if(!panel)return false;
    const key=identity(panel),existing=key&&['left','right'].find(candidate=>identity(this.panels[candidate])===key);
    const target=existing || (side&&!this.panels[side]?side:null) || ['right','left'].find(candidate=>!this.panels[candidate]) || (replace?(side||this.focusSide):null);
    if(!target)return false;
    this.panels[target]=panel;this.focusSide=target;this.refreshLayout();return true;
  }
  bodyDestination(){return this.bodyLayout;}
  thoughtDestination(){return this.bodyLayout==='ready'?'bodyThink':this.bodyLayout+'Think';}
  begin(id) {
    const face=isFacePresentation(this.view.destination);
    this.epoch++;this.turn=id;this.phase='thinking';this.seen=new Set();this.lastActionAt=0;this.pending=null;this.turnHadAction=false;this.speechDestination='face';
    this.show(face?'faceThink':this.thoughtDestination(),'Thinking…');return this.epoch;
  }
  listening({typed=false}={}) { this.epoch++;this.turn=null;this.phase='listening';this.pending=null;this.speechDestination='face';this.show('face',typed?'Ready when you are':'I’m listening');return this.epoch; }
  progress(id,events) {
    if(id!==this.turn || !['thinking','action','searching'].includes(this.phase))return;
    for(const event of events || []){
      const key=JSON.stringify(event);if(this.seen.has(key))continue;this.seen.add(key);
      if(event.stage==='search_ready'){this.phase='searching';this.show('search','Looking that up…');continue;}
      if(['tool_start','tool_result'].includes(event.stage)){
        if(event.tool==='web_search'||event.tool==='prepare_web_search') {
          this.phase='searching';this.show('search','Looking that up…');continue;
        }
        const type=toolPanel(event.tool);if(!type)continue;
        // Availability and success require a real result payload; never invent values.
        this.phase='action';this.lastActionAt=this.now();
        this.pending={panel:pendingPanel(type,event.ok===false?'error':'pending'),side:['right','left'].find(side=>!this.panels[side])||null};
        this.show(this.thoughtDestination(),event.ok===false?'That action needs attention':'Taking care of it…');
      }
    }
  }
  result(id,result,{timers=[],previousTimers=[],spotify}={}) {
    if(id!==this.turn)return false;
    const events=(result.tool_events||[]).filter(e=>toolPanel(e.tool));
    this.pending=null;
    this.turnHadAction=events.length>0 && !result.sources?.length && (result.reply?.length||0)<=280
      && !(result.tool_events||[]).some(event=>event.tool==='web_search');
    const completed=new Set(events.filter(event=>event.status==='completed').map(event=>toolPanel(event.tool))),confirmed=new Map();
    for(const presented of result.presentation||[]){
      const type=presented.type;
      if(!completed.has(type)&&!(type==='routine-saved'&&completed.has('routine')))continue;
      if(type==='timer'){
        const actual=timers.find(timer=>timer.id===presented.id) || (presented.id&&presented.ends_at&&presented.duration_seconds?presented:null);
        if(actual)confirmed.set(identity(presented),timerPanel(actual,this.now()));
      }else if(identity(presented))confirmed.set(identity(presented),presented);
    }
    if(completed.has('timer')&&![...confirmed.values()].some(panel=>panel.type==='timer')){
      const previous=new Map(previousTimers.map(timer=>[timer.id,timer.status]));
      const list=events.some(event=>event.tool==='list_timers'&&event.status==='completed');
      for(const timer of timers)if(list||!previous.has(timer.id)||previous.get(timer.id)!==timer.status)confirmed.set('timer:'+timer.id,timerPanel(timer,this.now()));
    }
    if(completed.has('music'))confirmed.set('music',musicPanel(spotify));
    for(const panel of confirmed.values())this.remember(panel);
    if(events.length){
      this.phase='action';this.lastActionAt=this.now();
      this.show(this.bodyLayout,events.some(event=>event.status==='failed')?'That action needs attention':confirmed.size?'Here’s the result':'Check the action outcome below');
    }
    return true;
  }
  reply(id){if(id!==this.turn)return false;this.pending=null;this.speechDestination=this.actionRepliesInBody&&this.turnHadAction&&this.panel?this.bodyLayout:'face';this.phase='reply';this.show(this.speechDestination,'MERLIN');return true;}
  prepareSpeech({destination=this.speechDestination}={}){this.pending=null;this.speechDestination=destination;this.phase='reply';this.show(destination,'MERLIN');}
  speaking({destination,body=false}={}){this.speechDestination=destination||(body?this.bodyLayout:this.speechDestination);this.phase='speaking';this.show(this.speechDestination,'Speaking');}
  followup({external=false}={}){this.phase='followup';this.deadline=external?Infinity:this.now()+FOLLOWUP_DELAY;this.show(this.speechDestination,'Ready for a follow-up');}
  standby(){this.epoch++;this.turn=null;this.pending=null;this.phase='idle';this.deadline=this.now()+IDLE_DELAY;this.show(this.bodyLayout,'Here when you need me');}
  inspect(panel){if(['listening','thinking','action','searching','speaking'].includes(this.phase))return false;this.epoch++;this.turn=null;this.pending=null;this.phase='panel';this.remember(panel,undefined,{replace:true});this.deadline=Infinity;this.show(this.bodyLayout,panel.label||labels[panel.type]);return true;}
  timerFinished(timer){
    if(!['idle','ambient','panel'].includes(this.phase))return false;
    this.epoch++;this.turn=null;this.pending=null;this.phase='panel';this.remember(timerPanel(timer,this.now()));this.deadline=Infinity;this.speechDestination=this.bodyLayout;
    this.show(this.bodyLayout,'Timer finished');return true;
  }
  dismiss(side){
    if(side&&!['left','right'].includes(side))return false;
    const paired=this.bodyLayout==='both',wasBody=!isFacePresentation(this.view.destination);
    if(side)this.panels[side]=null;else this.panels={left:null,right:null};
    this.pending=null;this.refreshLayout({seated:paired&&Boolean(side)});
    if(!isFacePresentation(this.speechDestination))this.speechDestination=this.bodyLayout;
    if(['panel','idle','ambient','error'].includes(this.phase)){this.phase=this.panel?'panel':'idle';this.deadline=this.panel?Infinity:this.now()+IDLE_DELAY;}
    this.show(wasBody?this.bodyLayout:this.view.destination,this.panel?.label||this.view.label,this.panel,{dismiss:true});return true;
  }
  expandPanel(side=this.focusSide){
    if(!this.panels[side]||Object.values(this.panels).filter(Boolean).length!==1||['listening','thinking','action','searching','speaking'].includes(this.phase))return false;
    const panel=this.panels[side];this.panels={left:null,right:panel};this.focusSide='right';this.panel=panel;this.bodyLayout='ceiling';this.phase='panel';this.pending=null;this.show('ceiling',panel.label||labels[panel.type]);return true;
  }
  dockPanel(side){
    if(!['left','right'].includes(side)||Object.values(this.panels).filter(Boolean).length!==1||['listening','thinking','action','searching','speaking'].includes(this.phase))return false;
    const panel=this.panels.left||this.panels.right;this.panels={left:null,right:null};this.panels[side]=panel;this.focusSide=side;this.panel=panel;this.bodyLayout=side;this.phase='panel';this.pending=null;this.show(side,panel.label||labels[panel.type]);return true;
  }
  restoreTimers(timers=[]){
    if(this.restoredTimers)return false;this.restoredTimers=true;
    let changed=false;for(const timer of timers)if(timer.status==='running')changed=this.remember(timerPanel(timer,this.now()))||changed;
    if(changed)this.show(['idle','ambient','panel'].includes(this.phase)?this.bodyLayout:this.view.destination,this.view.label);return changed;
  }
  syncTimers(timers=[]){
    const paired=this.bodyLayout==='both';let changed=false;
    for(const side of ['left','right']){
      const panel=this.panels[side];if(panel?.type!=='timer'||!panel.id)continue;
      const actual=timers.find(timer=>timer.id===panel.id),next=actual?timerPanel(actual,this.now()):null;
      if(!next||!sameTimer(panel,next)){this.panels[side]=next;changed=true;}
    }
    if(!changed)return false;
    this.refreshLayout({seated:paired&&Object.values(this.panels).filter(Boolean).length===1});
    const wasBody=panelSides(this.view.destination).length>0;
    const destination=wasBody?(this.view.destination.endsWith('Think')?this.thoughtDestination():this.bodyLayout):this.view.destination;
    if(wasBody&&!isFacePresentation(this.speechDestination))this.speechDestination=this.bodyLayout;
    this.show(destination,this.view.label);return true;
  }
  error(message){this.phase='error';this.turn=null;this.pending=null;this.speechDestination='face';this.deadline=this.now()+FOLLOWUP_DELAY;this.show('face',message);}
  tick(){
    if(this.now()<this.deadline)return;
    if(['followup','error'].includes(this.phase)){this.standby();return;}
    if(!['idle','ambient'].includes(this.phase)||this.reducedMotion||this.panel)return;
    this.phase='ambient';const activity=this.musicPlaying?'dance':idleActivities[this.idleIndex++%idleActivities.length];
    this.deadline=this.now()+30_000;this.show(activity,'Here when you need me');
  }
}
