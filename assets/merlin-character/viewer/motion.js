import { LoopOnce,LoopRepeat } from './vendor/three/build/three.module.min.js';
import {planRoute,dismissalDestination,isFaceState,stateScreens} from './motion-routes.js';

/** Route through the shared ready/full-face poses, retaining the latest request. */
export class MotionController {
  constructor(mixer,clips,manifest,onChange=()=>{}){
    this.mixer=mixer;this.clips=new Map(clips.map(c=>[c.name,c]));this.states=manifest.states;this.routes=manifest.routes||[];
    this.current='ready';this.desired='ready';this.bodyContext='ready';this.phase='idle';this.paused=false;
    this.onChange=onChange;this.active=null;this.retiring=[];this.clock=0;
    mixer.addEventListener('finished',event=>{
      if(event.action!==this.active)return;
      const previous=this.current,rest=this.states[previous].rest;
      if(this.phase==='idle'){
        if(!rest)return;
        this.current=rest;this.arrival=rest;
      }else this.current=this.phase==='finishLoop'?(this.desired===previous?(rest||previous):(this.states[this.arrival].rest||this.arrival)):this.arrival;
      if(this.desired===previous&&rest&&this.current===rest)this.desired=rest;
      if(!isFaceState(this.current,this.states)&&!isFaceState(this.desired,this.states))this.bodyContext=this.current;
      this.phase='idle';this.route();
    });
    this.play(this.states.ready.idle,true);
  }
  go(state){
    if(!this.states[state])throw new RangeError('Unknown MERLIN state: '+state);
    const pending=this.phase==='idle'?this.current:this.arrival;
    if(state==='bodyThink'){
      if(isFaceState(this.desired,this.states)||isFaceState(pending,this.states))state='faceThink';
      else {
        const base=this.desired.endsWith('Think')?this.desired:pending;
        state=this.states[base+'Think']?base+'Think':base.endsWith('Think')?base:
          Object.keys(this.states).find(name=>this.states[name].parent===base&&this.states[name].contextualThinking)||'bodyThink';
      }
    }
    if(isFaceState(state,this.states)&&!isFaceState(pending,this.states))this.bodyContext=this.states[pending].rest||pending;
    if(state==='ready'&&isFaceState(pending,this.states)&&stateScreens(this.bodyContext).some(side=>side!=='camera'))state=this.bodyContext;
    return this.request(state);
  }
  request(state){
    this.desired=state;this.resume();if(this.phase==='idle')this.route();return this;
  }
  body(){return this.request(isFaceState(this.current,this.states)||isFaceState(this.desired,this.states)?this.bodyContext:this.desired);}
  ready(){return this.request('ready');}
  /** Conversation interrupts ambient choreography; the studio's normal routes stay unchanged. */
  snap(state,{paused=false}={}){
    if(!this.states[state])throw new RangeError('Unknown MERLIN state: '+state);
    this.mixer.stopAllAction();this.retiring=[];this.active=null;
    this.current=state;this.desired=state;this.arrival=state;this.phase='idle';
    this.paused=paused;this.mixer.timeScale=1;
    this.play(this.states[state].idle,true);
    // Sample now, even with reduced motion, so a paused body can become a face.
    this.mixer.update(0);this.mixer.timeScale=paused?0:1;
    return this;
  }
  dismissScreen(side){
    const fromFace=isFaceState(this.desired,this.states);
    const source=fromFace?this.bodyContext:this.desired;
    const destination=dismissalDestination(source,side);
    if(destination!==source)this.request(destination);
    return this;
  }
  route(){
    if(this.current===this.desired){this.phase='idle';this.play(this.states[this.current].idle,true);return;}
    const next=planRoute(this.current,this.desired,this.states,this.routes,this.bodyContext)[0];
    // These older clips travel across the room / carry a ballistic prop.
    // Their fixed exits begin at the final pose, so finish the current cycle.
    if(['walk','walkReverse','toss'].includes(this.current)&&this.clip===this.states[this.current].idle&&this.active.isRunning()){
      this.phase='finishLoop';this.arrival=this.current;
      this.active.setLoop(LoopOnce,1);this.active.clampWhenFinished=true;this.notify();return;
    }
    this.phase=next.phase;this.arrival=next.to;this.play(next.clip,false);
  }
  play(name,loop){
    const clip=this.clips.get(name);if(!clip)throw new Error('Missing animation: '+name);
    const old=this.active,action=this.mixer.clipAction(clip);
    if(old===action&&loop&&action.isRunning()){this.notify();return;}
    // A walk is one traversal. Its matching held endpoint takes over on finish.
    const repeat=loop&&!this.states[this.current].rest;
    // Reusing an action must cancel any earlier scheduled stop for that action.
    this.retiring=this.retiring.filter(item=>item.action!==action);
    action.reset().setEffectiveTimeScale(1).setEffectiveWeight(1);
    action.setLoop(repeat?LoopRepeat:LoopOnce,repeat?Infinity:1);action.clampWhenFinished=!repeat;action.play();
    if(old&&old!==action){action.crossFadeFrom(old,.18,false);this.retiring.push({action:old,at:this.clock+.2});}
    this.active=action;this.clip=name;this.notify();
  }
  notify(){this.onChange({state:this.current,desired:this.desired,arrival:this.arrival,bodyContext:this.bodyContext,phase:this.phase,clip:this.clip,paused:this.paused});}
  pause(){this.paused=true;this.mixer.timeScale=0;this.notify();}
  resume(){this.paused=false;this.mixer.timeScale=1;this.notify();}
  update(dt){
    if(!this.paused)this.clock+=dt;
    this.mixer.update(dt);
    this.retiring=this.retiring.filter(item=>{if(item.at<=this.clock){if(item.action!==this.active)item.action.stop();return false;}return true;});
  }
}
