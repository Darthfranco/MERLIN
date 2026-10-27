import {isFaceState,contentDestination} from './motion-routes.js';

/** Edits destined for the left travel on the ceiling card before its mesh swap. */
export function screenEditPlan(motion,target){
  const destination=target==='ceiling'?'right':target;
  const contexts=[motion.current,...(motion.phase==='idle'?[]:[motion.arrival])];
  const expanded=state=>motion.states?isFaceState(state,motion.states):['face','camera','faceThink','search'].includes(state);
  if(contexts.some(expanded))contexts.push(motion.bodyContext);
  const routed=contentDestination(motion,target)?.replace(/Think$/,'');
  const carried=destination==='left'&&routed==='left'&&contexts.some(state=>state?.replace(/Think$/,'')==='ceiling');
  return {origin:carried?'right':destination,destination};
}

/** Capture request order and API content versions before asynchronous decoding. */
export function beginScreenEdit(screens,revisions,motion,target){
  const plan=screenEditPlan(motion,target),ids=[...new Set([plan.origin,plan.destination])];
  const tokens=ids.map(id=>({id,revision:revisions[id]=(revisions[id]||0)+1,version:screens[id].version}));
  const valid=()=>tokens.every(({id,revision,version})=>revisions[id]===revision&&screens[id].version===version);
  return {...plan,valid,commit(paint){
    if(!valid())return false;
    paint(screens[plan.origin]);
    if(plan.origin!==plan.destination)screens[plan.destination].copyFrom(screens[plan.origin]);
    return true;
  }};
}

/** Copy on the authored ceiling-to-left handoff, keeping live sources intact. */
export class ScreenHandoff {
  constructor(screens,onCopy=()=>{}){this.screens=screens;this.onCopy=onCopy;this.clip=null;this.version=-1;}
  sync(clip,sourceChanged=false){
    const active=clip==='CeilingToLeftPanel';
    if(active||this.clip==='CeilingToLeftPanel'){
      if(sourceChanged||this.version!==this.screens.right.version){
        this.screens.left.copyFrom(this.screens.right);this.version=this.screens.right.version;this.onCopy();
      }
    }
    this.clip=clip;if(!active)this.version=-1;
  }
}
