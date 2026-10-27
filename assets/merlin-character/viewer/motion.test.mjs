import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AnimationMixer,AnimationClip,Object3D,NumberKeyframeTrack,LoopOnce } from './vendor/three/build/three.module.min.js';
import { MotionController } from './motion.js';
import {planRoute,visibleScreens,contentDestination} from './motion-routes.js';

const manifest=JSON.parse(readFileSync(new URL('../states.json',import.meta.url)));
function fixture({walkingPositions=false}={}){
  const model=new Object3D();
  const positions={WalkWhistle:[-3.1,3.1],WalkPaused:[3.1,3.1],WalkToThink:[3.1,3.1],WalkThinking:[3.1,3.1],
    WalkWhistleReverse:[3.1,-3.1],WalkReversePaused:[-3.1,-3.1],WalkReverseToThink:[-3.1,-3.1],WalkReverseThinking:[-3.1,-3.1]};
  const clips=Object.entries(manifest.clips).map(([name,meta])=>new AnimationClip(name,(meta.frames-1)/24,[new NumberKeyframeTrack('.position[x]',[0,(meta.frames-1)/24],walkingPositions&&positions[name]||[0,0])]));
  return new MotionController(new AnimationMixer(model),clips,manifest);
}
function advance(c,seconds=40){for(let i=0;i<seconds*60;i++)c.update(1/60);}
function arrive(c,state){
  for(let i=0;i<40*60&&(c.current!==state||c.phase!=='idle');i++)c.update(1/60);
  assert.equal(c.current,state);assert.equal(c.phase,'idle');advance(c,.25);
}
test('every pair of states routes to its requested idle without a dead end',()=>{
  for(const start of Object.keys(manifest.states))for(const end of Object.keys(manifest.states)){
    const c=fixture();c.go(start);arrive(c,start);
    c.request(end);arrive(c,end);assert.equal(c.current,end,`${start} → ${end}`);assert.equal(c.phase,'idle');
    assert.equal(c.clip,manifest.states[end].idle);assert.equal(c.retiring.length,0);
  }
});
test('requests during a transition coalesce to the latest destination',()=>{
  const c=fixture();c.go('left');advance(c,.5);c.go('camera');advance(c,.25);c.go('dance');advance(c);
  assert.equal(c.current,'dance');assert.equal(c.phase,'idle');
});
test('pause holds playhead and an explicit destination resumes playback',()=>{
  const c=fixture();c.go('camera');advance(c,.25);c.pause();const at=c.active.time;
  advance(c,4);assert.equal(c.active.time,at);assert.equal(c.paused,true);
  c.go('bodyThink');advance(c);assert.equal(c.current,'faceThink');assert.equal(c.paused,false);
});
test('unknown state fails before changing the requested destination',()=>{
  const c=fixture();assert.throws(()=>c.go('missing'),RangeError);assert.equal(c.desired,'ready');
});
test('walking and tossing finish their current cycles before a fixed return',()=>{
  for(const state of ['walk','toss']){
    const c=fixture();c.go(state);advance(c,4.5);c.go('ready');
    assert.equal(c.phase,'finishLoop');advance(c,1);assert.equal(c.current,state);
    advance(c);assert.equal(c.current,'ready');assert.equal(c.phase,'idle');
  }
});
test('choosing the current activity again cancels a pending return cleanly',()=>{
  const c=fixture();c.go('walk');advance(c,4.5);c.go('ready');c.go('walk');advance(c);
  assert.equal(c.current,'walkRest');assert.equal(c.phase,'idle');assert.equal(c.active.isRunning(),true);
});
test('each selective dismissal uses its direct seated clip and preserves the opposite screen',()=>{
  for(const [side,remaining,clip] of [['left','seatedRight','BothToRightPanel'],['right','seatedLeft','BothToLeftPanel']]){
    const c=fixture();c.go('both');advance(c);
    c.dismissScreen(side);
    assert.equal(c.clip,clip);assert.equal(c.arrival,remaining);
    assert.deepEqual([...visibleScreens(c)].sort(),['left','right']);
    advance(c);assert.equal(c.current,remaining);assert.equal(c.phase,'idle');
    assert.deepEqual([...visibleScreens(c)],[side==='left'?'right':'left']);
    c.dismissScreen(side);assert.equal(c.current,remaining);assert.equal(c.desired,remaining);
    c.dismissScreen(side==='left'?'right':'left');assert.equal(c.clip,manifest.states[remaining].exit);
    advance(c);assert.equal(c.current,'ready');
  }
});
test('dismiss both returns through its authored exit without visiting a single-panel state',()=>{
  const c=fixture();c.go('both');advance(c);c.dismissScreen('both');
  assert.equal(c.clip,'BothPanelsToReady');assert.equal(c.arrival,'ready');advance(c);assert.equal(c.current,'ready');
});
test('rapid dismissals during entry compose against the requested arrangement',()=>{
  const c=fixture();c.go('both');advance(c,.25);const entry=c.active;
  c.dismissScreen('left');assert.equal(c.desired,'seatedRight');assert.equal(c.active,entry);
  c.dismissScreen('right');assert.equal(c.desired,'ready');assert.equal(c.active,entry);
  advance(c);assert.equal(c.current,'ready');assert.equal(c.phase,'idle');
  assert.throws(()=>c.dismissScreen('missing'),RangeError);assert.equal(c.desired,'ready');
});
test('a new activity requested during selective dismissal finishes that clip then exits the remaining screen',()=>{
  const c=fixture();c.go('both');advance(c);c.dismissScreen('left');advance(c,.2);const dismissal=c.active;
  c.go('dance');assert.equal(c.active,dismissal);const played=[];c.onChange=info=>played.push(info.clip);
  advance(c);assert.equal(c.current,'dance');
  assert.ok(played.includes('SeatedRightToReady'));assert.ok(!played.includes('BothPanelsToReady'));
});
test('entering a single seated panel routes through the two-screen arrangement',()=>{
  assert.deepEqual(planRoute('ready','seatedLeft',manifest.states,manifest.routes).map(edge=>edge.clip),['ReadyToBothPanels','BothToLeftPanel']);
  assert.deepEqual(planRoute('seatedLeft','seatedRight',manifest.states,manifest.routes).map(edge=>edge.clip),['SeatedLeftToReady','ReadyToBothPanels','BothToRightPanel']);
});
test('editing visible content keeps both or the remaining seated panel in place',()=>{
  for(const state of ['both','seatedLeft','seatedRight']){
    const c=fixture();c.go(state);advance(c);
    for(const screen of visibleScreens(c))assert.equal(contentDestination(c,screen),state);
  }
  const c=fixture();c.go('both');advance(c,.5);
  assert.deepEqual([...visibleScreens(c)].sort(),['left','right']);
  assert.equal(contentDestination(c,'left'),'both');assert.equal(contentDestination(c,'right'),'both');
});
test('each panel arrangement expands directly to full face and restores without dismissing a screen',()=>{
  for(const state of ['left','right','both','seatedLeft','seatedRight','ceiling']){
    const c=fixture();c.go(state);advance(c);const played=[];c.onChange=info=>played.push(info.clip);
    c.go('camera');advance(c);assert.equal(c.current,'camera');assert.equal(c.bodyContext,state);
    c.body();advance(c);assert.equal(c.current,state);
    for(const clip of played)assert.ok(!/ToReady$/.test(clip),`${state}: unexpected dismissal ${clip}`);
  }
});
test('editing remembered panel content from any full-face mode restores its paired or seated layout',()=>{
  for(const state of ['both','seatedLeft','seatedRight','ceiling'])for(const face of ['face','camera','faceThink','search']){
    const c=fixture();c.go(state);advance(c);const surfaces=[...visibleScreens(c)];c.go(face);advance(c);
    for(const screen of surfaces)assert.equal(contentDestination(c,screen),state,`${state} in ${face}: ${screen}`);
    const played=[];c.onChange=info=>played.push(info.clip);c.go(contentDestination(c,surfaces[0]));advance(c);
    assert.equal(c.current,state);assert.ok(played.every(clip=>!/ToReady$/.test(clip)));
  }
});
test('Deep thought stays in each body context and uses the face expression when already expanded',()=>{
  for(const state of ['left','right','both','seatedLeft','seatedRight','ceiling','dance','nap','toss','walk','walkReverse']){
    const c=fixture();c.go(state);advance(c);c.go('bodyThink');advance(c);
    assert.equal(c.current,state+'Think');
    c.go('face');advance(c);assert.equal(c.current,'face');assert.equal(c.bodyContext,state+'Think');
    c.go('bodyThink');advance(c);assert.equal(c.current,'faceThink');
    c.body();advance(c);assert.equal(c.current,state+'Think');
  }
});
test('a face request during panel entry preserves that pending layout',()=>{
  const c=fixture();c.go('both');advance(c,.25);c.go('face');advance(c);
  assert.equal(c.current,'face');assert.equal(c.bodyContext,'both');
  c.go('ready');advance(c);assert.equal(c.current,'both');
  c.ready();advance(c);assert.equal(c.current,'ready');
});
test('dismissal from full face first restores the same paired layout then removes only the requested side',()=>{
  const c=fixture();c.go('both');advance(c);c.go('face');advance(c);c.dismissScreen('left');
  assert.equal(c.desired,'seatedRight');assert.equal(c.clip,'FaceToBoth');advance(c);assert.equal(c.current,'seatedRight');
});
test('walking in either direction finishes its cycle and restores the same endpoint after a face excursion',()=>{
  for(const [walk,rest] of [['walk','walkRest'],['walkReverse','walkReverseRest']]){
    const c=fixture();c.go(walk);advance(c,4.5);c.go('face');assert.equal(c.phase,'finishLoop');
    advance(c);assert.equal(c.current,'face');assert.equal(c.bodyContext,rest);
    c.body();advance(c);assert.equal(c.current,rest);assert.equal(c.clip,manifest.states[rest].idle);
    c.go('bodyThink');advance(c);assert.equal(c.current,walk+'Think');
  }
});
test('canceling a queued held endpoint lets that walking pass finish without a ready detour',()=>{
  const c=fixture();c.go('walkRest');
  for(let i=0;i<2000&&c.phase!=='finishLoop';i++)c.update(1/60);
  assert.equal(c.phase,'finishLoop');assert.equal(c.arrival,'walkRest');
  const played=[];c.onChange=info=>played.push(info.clip);c.go('walk');advance(c);
  assert.equal(c.current,'walkRest');assert.equal(c.phase,'idle');
  assert.ok(!played.includes('WalkWhistleToReady'));
});
test('walking in either direction completes one pass and holds its matching endpoint without jumping',()=>{
  for(const [walk,rest,end] of [['walk','walkRest',3.1],['walkReverse','walkReverseRest',-3.1]]){
    const c=fixture({walkingPositions:true});c.go(walk);arrive(c,walk);
    assert.equal(c.active.loop,LoopOnce);
    assert.equal(c.active.clampWhenFinished,true);
    advance(c,12);assert.equal(c.current,rest);assert.equal(c.desired,rest);assert.equal(c.bodyContext,rest);
    assert.equal(c.clip,manifest.states[rest].idle);
    const x=c.mixer.getRoot().position.x;assert.ok(Math.abs(x-end)<1e-6);
    advance(c,24);assert.equal(c.current,rest);assert.ok(Math.abs(c.mixer.getRoot().position.x-x)<1e-6);
  }
});
test('a request after a naturally completed walk starts at the held endpoint without replaying travel',()=>{
  for(const [walk,rest,prefix] of [['walk','walkRest','Walk'],['walkReverse','walkReverseRest','WalkReverse']]){
    const c=fixture({walkingPositions:true});c.go(walk);advance(c);assert.equal(c.current,rest);
    const x=c.mixer.getRoot().position.x;c.go('bodyThink');assert.equal(c.clip,prefix+'ToThink');
    c.update(1/60);assert.ok(Math.abs(c.mixer.getRoot().position.x-x)<1e-6);
    advance(c);assert.equal(c.current,walk+'Think');assert.ok(Math.abs(c.mixer.getRoot().position.x-x)<1e-6);
  }
});
test('the ceiling screen docks directly to either panel and its content target preserves the large layout',()=>{
  for(const side of ['left','right']){
    const c=fixture();assert.equal(contentDestination(c,'ceiling'),'ceiling');c.go('ceiling');advance(c);
    assert.equal(contentDestination(c,'ceiling'),'ceiling');assert.equal(contentDestination(c,'right'),'ceiling');
    c.go(side);assert.equal(c.clip,side==='left'?'CeilingToLeftPanel':'CeilingToRightPanel');
    assert.deepEqual([...visibleScreens(c)].sort(),side==='left'?['left','right']:['right']);
    advance(c);assert.equal(c.current,side);
  }
});
