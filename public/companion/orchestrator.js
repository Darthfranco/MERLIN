/** Foreground presentation only. No device, memory, or model execution lives here. */
export const IDLE_DELAY = 20_000;
export const FOLLOWUP_DELAY = 10_000;
export const ACTION_HOLD = 1_200;
const idleActivities = ['sweep', 'walk', 'toss'];
export const toolPanel = tool => /^(create|cancel|list)_timer/.test(tool) ? 'timer'
  : tool?.startsWith('spotify_') ? 'music' : tool === 'routine_save' ? 'routine-saved'
    : ['routine_read', 'routine_use'].includes(tool) ? 'routine' : null;
const labels = {timer:'Your timer',music:'Spotify',lights:'Lights',oven:'Oven',schedule:'Schedules',routine:'Your routine','routine-saved':'Your routine'};
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
  constructor({render=()=>{},now=()=>Date.now(),reducedMotion=false}={}) {
    this.render=render;this.now=now;this.reducedMotion=reducedMotion;this.epoch=0;this.idleIndex=0;
    this.phase='idle';this.deadline=now()+IDLE_DELAY;this.panel=null;this.panels={left:null,right:null};this.focusSide='right';this.turn=null;this.lastActionAt=0;
    this.view={destination:'ready',label:'Here when you need me',phase:'idle',panel:null};
    this.render(this.view);
  }
  show(destination,label,panel=this.panel) {
    this.view={destination,label,panel,panels:{...this.panels},focusSide:this.focusSide,phase:this.phase,epoch:this.epoch};this.render(this.view);return this.view;
  }
  remember(panel,side){
    const existing=panel?.id&&['left','right'].find(key=>this.panels[key]?.id===panel.id&&this.panels[key]?.type===panel.type);
    const placeholder=['left','right'].find(key=>this.panels[key]?.type===panel?.type&&['pending','unknown','error'].includes(this.panels[key]?.status));
    this.focusSide=side||existing||placeholder||(!this.panels.right?'right':!this.panels.left?'left':this.focusSide==='right'?'left':'right');
    this.panels[this.focusSide]=panel;this.panel=panel;return this.bodyDestination();
  }
  bodyDestination(){return this.panels.left&&this.panels.right?'both':this.panels.left?'left':'right';}
  begin(id) { this.epoch++;this.turn=id;this.phase='thinking';this.seen=new Set();this.lastActionAt=0;this.show('faceThink','Thinking…');return this.epoch; }
  listening({typed=false}={}) { this.epoch++;this.turn=null;this.phase='listening';this.show('face',typed?'Ready when you are':'I’m listening');return this.epoch; }
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
        this.remember(pendingPanel(type,event.ok===false?'error':'pending'));this.show(this.bodyDestination(),event.ok===false?'That action needs attention':'Taking care of it…');
      }
    }
  }
  result(id,result,{timers=[],previousTimers=[],spotify}={}) {
    if(id!==this.turn)return false;
    const events=(result.tool_events||[]).filter(e=>toolPanel(e.tool));
    const presentedIds=new Set(),fallbackIds=new Set();
    for(const last of events){
      const type=toolPanel(last.tool);
      const presented=last.status==='completed'?(result.presentation||[]).find(p=>!presentedIds.has(p)&&(p.type===type || type==='routine'&&p.type==='routine-saved')):null;
      if(presented)presentedIds.add(presented);
      let panel=presented || pendingPanel(type,last.status==='failed'?'error':'unknown');
      if(type==='timer'&&last.status==='completed'){
        const previous=new Map(previousTimers.map(t=>[t.id,t.status]));
        const changed=timers.filter(t=>!fallbackIds.has(t.id)&&(!previous.has(t.id)||previous.get(t.id)!==t.status));
        const actual=(presented?.id&&timers.find(t=>t.id===presented.id)) || changed[0] || (last.tool==='list_timers'?timers[0]:null);
        if(actual)fallbackIds.add(actual.id);
        panel=timerPanel(actual,this.now());
      }
      if(type==='music'&&last.status==='completed')panel=musicPanel(spotify);
      this.phase='action';this.lastActionAt=this.now();
      this.remember(panel);
      this.show(this.bodyDestination(),last.status==='failed'?'That action needs attention':'Here’s the result');
    }
    return true;
  }
  reply(id){if(id!==this.turn)return false;this.phase='reply';this.show('face','MERLIN');return true;}
  speaking({body=false}={}){this.phase='speaking';this.show(body?this.bodyDestination():'face','Speaking');}
  followup({external=false}={}){this.phase='followup';this.deadline=external?Infinity:this.now()+FOLLOWUP_DELAY;this.show('face','Ready for a follow-up');}
  standby(){this.epoch++;this.turn=null;this.phase='idle';this.deadline=this.now()+IDLE_DELAY;this.show('ready','Here when you need me');}
  inspect(panel){if(['listening','thinking','action','searching','speaking'].includes(this.phase))return false;this.epoch++;this.turn=null;this.phase='panel';this.remember(panel);this.deadline=Infinity;this.show(this.bodyDestination(),panel.label||labels[panel.type]);return true;}
  timerFinished(timer){if(!['idle','ambient','panel'].includes(this.phase))return false;return this.inspect(timerPanel(timer,this.now()));}
  dismiss(side){if(side)this.panels[side]=null;else this.panels={left:null,right:null};this.focusSide=this.panels.right?'right':'left';this.panel=this.panels[this.focusSide];if(this.phase==='panel'){if(this.panel)this.show(this.bodyDestination(),this.panel.label);else this.standby();}else if(['idle','ambient','error'].includes(this.phase))this.standby();else this.show(this.view.destination,this.view.label,this.panel);}
  error(message){this.phase='error';this.turn=null;this.deadline=this.now()+FOLLOWUP_DELAY;this.show('face',message);}
  tick(){
    if(this.now()<this.deadline)return;
    if(['followup','error'].includes(this.phase)){this.standby();return;}
    if(!['idle','ambient'].includes(this.phase)||this.reducedMotion)return;
    this.phase='ambient';const activity=this.musicPlaying?'dance':idleActivities[this.idleIndex++%idleActivities.length];
    this.deadline=this.now()+30_000;this.show(activity,'Here when you need me');
  }
}
