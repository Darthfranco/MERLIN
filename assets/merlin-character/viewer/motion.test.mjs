import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AnimationMixer,AnimationClip,Object3D,NumberKeyframeTrack } from './vendor/three/build/three.module.min.js';
import { MotionController } from './motion.js';

const manifest=JSON.parse(readFileSync(new URL('../states.json',import.meta.url)));
function fixture(){
  const model=new Object3D();
  const clips=Object.entries(manifest.clips).map(([name,meta])=>new AnimationClip(name,(meta.frames-1)/24,[new NumberKeyframeTrack('.position[x]',[0,(meta.frames-1)/24],[0,0])]));
  return new MotionController(new AnimationMixer(model),clips,manifest);
}
function advance(c,seconds=40){for(let i=0;i<seconds*60;i++)c.update(1/60);}
test('every pair of states routes to its requested idle without a dead end',()=>{
  for(const start of Object.keys(manifest.states))for(const end of Object.keys(manifest.states)){
    const c=fixture();c.go(start);advance(c);assert.equal(c.current,start);
    c.go(end);advance(c);assert.equal(c.current,end,`${start} → ${end}`);assert.equal(c.phase,'idle');
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
  c.go('bodyThink');advance(c);assert.equal(c.current,'bodyThink');assert.equal(c.paused,false);
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
  assert.equal(c.current,'walk');assert.equal(c.phase,'idle');assert.equal(c.active.isRunning(),true);
});
