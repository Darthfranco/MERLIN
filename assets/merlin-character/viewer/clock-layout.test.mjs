import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AnimationMixer, AnimationClip, Object3D, NumberKeyframeTrack} from './vendor/three/build/three.module.min.js';
import {MotionController} from './motion.js';
import {CLOCK_SPOTS, clockAnchors, clockMotionPlan, chooseClockSpot, formatSceneTime} from './clock-layout.js';

const {states, clips: metadata} = JSON.parse(readFileSync(new URL('../states.json', import.meta.url)));
const size = {width: 1000, height: 750, clockWidth: 270, clockHeight: 110};
const initial = {current:'ready', desired:'ready', phase:'idle', clip:'ReadyIdle'};
const advance = (c, seconds) => {for(let t=0;t<seconds;t+=1/60)c.update(1/60);};

test('exactly five inset positions stay on stage at desktop and narrow sizes', () => {
  for (const width of [288, 358, 896, 1200]) {
    const height = width * .75;
    const anchors = clockAnchors(width, height, width * .27, width * .13);
    assert.deepEqual(anchors.map(a => a.id), CLOCK_SPOTS);
    for (const a of anchors) {
      assert.ok(a.x > 0 && a.y > 0);
      assert.ok(a.x + a.width < width && a.y + a.height < height);
    }
  }
});

test('walking reserves both directions and uses the clear top band instead of the next empty corner', () => {
  const obstacles = [{left:0, top:.3, right:1, bottom:.98}];
  const selected = chooseClockSpot({...size, current:'lower-right', obstacles});
  assert.ok(selected.id.startsWith('upper-'));
  assert.equal(selected.overlap, 0);
  assert.equal(chooseClockSpot({...size, current:selected.id, obstacles}).id, selected.id);
});

test('right and left panels each displace a covered clock to an unobstructed spot', () => {
  for (const side of ['left', 'right']) {
    const obstacles = [{left:side === 'left' ? 0 : .5, right:side === 'left' ? .5 : 1, top:0, bottom:1}];
    const selected = chooseClockSpot({...size, current:`upper-${side}`, obstacles});
    assert.equal(selected.id, side === 'left' ? 'upper-right' : 'upper-left');
    assert.equal(selected.overlap, 0);
  }
});

test('all five positions can be chosen and safe positions remain steady as obstacles disappear', () => {
  const anchors = clockAnchors(size.width, size.height, size.clockWidth, size.clockHeight);
  for (const anchor of anchors) {
    // Narrow blockers at every other anchor center leave exactly the target clear.
    const obstacles = anchors.filter(a => a.id !== anchor.id).map(a => ({
      left:(a.x+130)/1000, right:(a.x+140)/1000, top:(a.y+50)/750, bottom:(a.y+60)/750,
    }));
    assert.equal(chooseClockSpot({...size, obstacles}).id, anchor.id);
    assert.equal(chooseClockSpot({...size, current:anchor.id, obstacles:[]}).id, anchor.id);
  }
});

test('no-clear-spot fallback is deterministic and does not hide the clock', () => {
  const result = chooseClockSpot({...size, current:'upper-middle', obstacles:[{left:0,top:0,right:1,bottom:1}]});
  assert.equal(result.id, 'upper-middle');
  assert.ok(result.overlap > 0);
});

test('prediction includes the unfinished transition, both panel routes and destination idle', () => {
  const plan = clockMotionPlan({...initial, phase:'enter', arrival:'right', desired:'left', clip:'ReadyToPanel'}, states);
  assert.deepEqual(plan.clips, ['ReadyToPanel','PanelToReady','ReadyToLeftPanel','LeftPanelIdle']);
  assert.equal(plan.hidden, false);
  assert.deepEqual(plan.occlusionClips, ['ReadyToPanel','PanelIdle','PanelToReady']);
  assert.deepEqual(clockMotionPlan({...initial, desired:'walk'}, states).clips, ['ReadyIdle','ReadyToWalkWhistle','WalkWhistle']);
});

test('full-face entry, every descendant, and the entire return hide time', () => {
  assert.equal(clockMotionPlan({...initial,phase:'enter',arrival:'face',desired:'camera',clip:'ReadyToFace'},states).hidden,true);
  for (const current of ['face','camera','faceThink','search']) {
    assert.equal(clockMotionPlan({current,desired:current,phase:'idle',clip:states[current].idle},states).hidden,true);
  }
  assert.equal(clockMotionPlan({current:'face',desired:'ready',arrival:'ready',phase:'exit',clip:'FaceToReady'},states).hidden,true);
  assert.equal(clockMotionPlan(initial,states).hidden,false);
  // A queued full face waits for the current body animation before disappearing.
  assert.equal(clockMotionPlan({current:'walk',desired:'face',arrival:'walk',phase:'finishLoop',clip:'WalkWhistle'},states).hidden,false);
  assert.deepEqual(clockMotionPlan({current:'walk',desired:'face',arrival:'walk',phase:'finishLoop',clip:'WalkWhistle'},states).occlusionClips,
    ['WalkWhistle','WalkWhistleToReady']);
});

test('predicted route covers every actual clip for every state pair, including pause and changed destinations', () => {
  const clips = Object.entries(metadata).map(([name, meta]) => new AnimationClip(name,(meta.frames-1)/24,[new NumberKeyframeTrack('.position[x]',[0,(meta.frames-1)/24],[0,0])]));
  for (const start of Object.keys(states)) for (const end of Object.keys(states)) {
    const c = new MotionController(new AnimationMixer(new Object3D()),clips,{states});
    c.go(start); advance(c,30);
    const predicted = clockMotionPlan({...c, desired:end}, states);
    const actual = new Set();
    c.onChange = info => actual.add(info.clip);
    c.go(end); c.pause(); advance(c,.25); c.resume(); advance(c,40);
    assert.equal(c.current,end);
    for (const clip of actual) assert.ok(predicted.clips.includes(clip), `${start} → ${end}: ${clip}`);
  }
});

test('locale, day rollover, and daylight saving use the real wall clock', () => {
  assert.deepEqual(formatSceneTime(new Date('2026-10-28T03:59:00Z'), 'en-US','America/New_York'), {
    time:'11:59',period:'PM',date:'Tue, Oct 27',label:'Tuesday, October 27, 2026 at 11:59 PM',
  });
  assert.equal(formatSceneTime(new Date('2026-10-28T04:00:00Z'),'en-US','America/New_York').date,'Wed, Oct 28');
  assert.equal(formatSceneTime(new Date('2026-11-01T06:00:00Z'),'en-US','America/New_York').time,'1:00');
  const military = formatSceneTime(new Date('2026-10-28T03:59:00Z'),'en-GB','America/New_York');
  assert.equal(military.time,'23:59'); assert.equal(military.period,'');
});
