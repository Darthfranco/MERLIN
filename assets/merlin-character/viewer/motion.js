import { LoopOnce,LoopRepeat } from './vendor/three/build/three.module.min.js';

/** Route through the shared ready/full-face poses, retaining the latest request. */
export class MotionController {
  constructor(mixer,clips,manifest,onChange=()=>{}){
    this.mixer=mixer;this.clips=new Map(clips.map(c=>[c.name,c]));this.states=manifest.states;
    this.current='ready';this.desired='ready';this.phase='idle';this.paused=false;
    this.onChange=onChange;this.active=null;this.retiring=[];this.clock=0;
    mixer.addEventListener('finished',event=>{
      if(event.action!==this.active||this.phase==='idle')return;
      this.current=this.arrival;this.phase='idle';this.route();
    });
    this.play(this.states.ready.idle,true);
  }
  ancestors(state){const path=[];for(let s=state;s;s=this.states[s].parent)path.push(s);return path;}
  go(state){
    if(!this.states[state])throw new RangeError('Unknown MERLIN state: '+state);
    this.desired=state;this.resume();if(this.phase==='idle')this.route();return this;
  }
  route(){
    if(this.current===this.desired){this.phase='idle';this.play(this.states[this.current].idle,true);return;}
    const path=this.ancestors(this.desired);
    if(path.includes(this.current)){
      const next=path[path.indexOf(this.current)-1];this.phase='enter';this.arrival=next;
      this.play(this.states[next].enter,false);
    }else{
      // These older clips travel across the room / carry a ballistic prop.
      // Their fixed exits begin at the final pose, so finish the current cycle.
      if(['walk','toss'].includes(this.current)&&this.clip===this.states[this.current].idle&&this.active.isRunning()){
        this.phase='finishLoop';this.arrival=this.current;
        this.active.setLoop(LoopOnce,1);this.active.clampWhenFinished=true;this.notify();return;
      }
      this.phase='exit';this.arrival=this.states[this.current].parent;
      this.play(this.states[this.current].exit,false);
    }
  }
  play(name,loop){
    const clip=this.clips.get(name);if(!clip)throw new Error('Missing animation: '+name);
    const old=this.active,action=this.mixer.clipAction(clip);
    if(old===action&&loop&&action.isRunning()){this.notify();return;}
    // Reusing an action must cancel any earlier scheduled stop for that action.
    this.retiring=this.retiring.filter(item=>item.action!==action);
    action.reset().setEffectiveTimeScale(1).setEffectiveWeight(1);
    action.setLoop(loop?LoopRepeat:LoopOnce,loop?Infinity:1);action.clampWhenFinished=!loop;action.play();
    if(old&&old!==action){action.crossFadeFrom(old,.18,false);this.retiring.push({action:old,at:this.clock+.2});}
    this.active=action;this.clip=name;this.notify();
  }
  notify(){this.onChange({state:this.current,desired:this.desired,phase:this.phase,clip:this.clip,paused:this.paused});}
  pause(){this.paused=true;this.mixer.timeScale=0;this.notify();}
  resume(){this.paused=false;this.mixer.timeScale=1;this.notify();}
  update(dt){
    if(!this.paused)this.clock+=dt;
    this.mixer.update(dt);
    this.retiring=this.retiring.filter(item=>{if(item.at<=this.clock){if(item.action!==this.active)item.action.stop();return false;}return true;});
  }
}
