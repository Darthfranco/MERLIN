import test from 'node:test';
import assert from 'node:assert/strict';
import {activityIdentity, projectActivities, floatingActivityPlan} from '../public/companion/floating-activities.js';

const timer = (id, extra = {}) => ({id, label: `${id} timer`, status: 'running', duration_seconds: 300,
  ends_at: '2026-10-27T12:05:00.000Z', ...extra});
const now = Date.parse('2026-10-27T12:01:00.000Z');
const spotify = {connected: true, playback: {is_playing: true, track: {name: 'Synthetic song', artists: ['Synthetic artist']}}};
const panel = id => ({type: 'timer', id});
const ids = cards => cards.map(card => card.id);

test('timer projection uses real identities and times without locally claiming completion', () => {
  const input = [timer('tea'), timer('due', {ends_at: '2026-10-27T12:00:00.000Z'}), timer('done', {status: 'completed'})];
  const before = structuredClone(input);
  const activities = projectActivities({timers: input, now});
  assert.deepEqual(ids(activities), ['timer:done', 'timer:tea', 'timer:due']);
  assert.equal(activities[0].data.status, 'finished'); assert.equal(activities[0].action, 'dismiss');
  assert.equal(activities[1].data.remainingSeconds, 240); assert.equal(activities[1].action, 'cancel');
  assert.equal(activities[2].data.remainingSeconds, 0); assert.equal(activities[2].data.status, 'running');
  assert.deepEqual(input, before);
});

test('dismissal, cancellation and duplicate snapshots cannot leave ghost activities', () => {
  const activities = projectActivities({now, timers: [timer('one'), timer('two', {status: 'cancelled'}),
    timer('hidden', {status: 'completed', dismissed: true}), timer('unknown', {status: 'pending'}),
    timer('one', {status: 'cancelled'}), timer('done', {status: 'completed'}), null, timer('')]});
  assert.deepEqual(ids(activities), ['timer:done']);
  assert.deepEqual(projectActivities({timers: null}), []);
});

test('invalid timing stays unknown and seven-day timers retain their precision', () => {
  const activities = projectActivities({now, timers: [timer('invalid', {ends_at: 'bad', duration_seconds: -1}),
    timer('week', {ends_at: new Date(now + 604800000).toISOString(), duration_seconds: 604800})]});
  assert.equal(activities[0].data.remainingSeconds, null); assert.equal(activities[0].data.durationSeconds, null);
  assert.equal(activities[1].data.remainingSeconds, 604800); assert.equal(activities[1].data.durationSeconds, 604800);
  assert.equal(projectActivities({now: NaN, timers: [timer('bad-clock')]} )[0].data.remainingSeconds, null);
});

test('Spotify projection is connected, current-track only and does not fabricate progress', () => {
  const [music] = projectActivities({spotify});
  assert.equal(music.id, 'music:spotify'); assert.equal(music.data.status, 'playing'); assert.equal(music.action, 'pause');
  assert.equal(music.data.positionSeconds, null); assert.equal(music.data.durationSeconds, null);
  const paused = projectActivities({spotify: {...spotify, playback: {...spotify.playback, is_playing: false}}})[0];
  assert.equal(paused.id, music.id); assert.equal(paused.action, 'resume'); assert.equal(paused.data.status, 'paused');
  for (const state of [{connected: false, playback: spotify.playback}, {connected: true},
    {connected: true, playback: {is_playing: true}}, {connected: true, playback: {track: {name: ''}}}]) {
    assert.deepEqual(projectActivities({spotify: state}), []);
  }
});

test('local projection selects display fields without copying provider credentials or links', () => {
  const input = {...spotify, access_token: 'synthetic-secret', playback: {...spotify.playback,
    device: {id: 'synthetic-device'}, progress_ms: 4200,
    track: {...spotify.playback.track, uri: 'spotify:track:synthetic', image_url: 'https://example.test/image', duration_ms: 180000}}};
  const before = structuredClone(input), [music] = projectActivities({spotify: input});
  assert.equal(music.data.positionSeconds, 4.2); assert.equal(music.data.durationSeconds, 180);
  assert.deepEqual(Object.keys(music.data).sort(), ['artist', 'durationSeconds', 'positionSeconds', 'status', 'title']);
  assert.deepEqual(input, before);
});

test('one body activity keeps its physical screen without a duplicate float', () => {
  for (const destination of ['right', 'rightThink', 'seatedRight', 'seatedRightThink', 'ceiling', 'ceilingThink']) {
    const plan = floatingActivityPlan({timers: [timer('tea')], now, destination, panels: {right: panel('tea')}});
    assert.equal(plan.mode, 'body'); assert.equal(plan.usesFloatingBody, false); assert.deepEqual(plan.cards, []);
    assert.equal(plan.physicalPanels.right.id, 'tea'); assert.equal(plan.activities.length, 1);
    assert.equal(plan.destination, destination); assert.equal(plan.restorePanels, true);
  }
  const plan = floatingActivityPlan({spotify, destination: 'left', panels: {left: {type: 'music'}}});
  assert.deepEqual(plan.cards, []); assert.equal(activityIdentity(plan.physicalPanels.left), 'music:spotify');
});

test('an activity not represented by a visible physical panel stays reachable in the scene', () => {
  const plan = floatingActivityPlan({timers: [timer('tea')], now, destination: 'ready', panels: {right: panel('tea')}});
  assert.deepEqual(ids(plan.cards), ['timer:tea']);
  assert.deepEqual(ids(floatingActivityPlan({timers: [timer('tea')], now, destination: 'left', panels: {left: {type: 'oven'}}}).cards), ['timer:tea']);
});

test('all face presentations retain compact activities and the underlying physical record', () => {
  for (const destination of ['face', 'faceThink', 'search', 'camera']) {
    const plan = floatingActivityPlan({timers: [timer('tea')], now, destination, panels: {right: panel('tea')}});
    assert.equal(plan.mode, 'face'); assert.deepEqual(ids(plan.cards), ['timer:tea']);
    assert.equal(plan.physicalPanels.right.id, 'tea'); assert.equal(plan.usesFloatingBody, false);
    assert.equal(plan.destination, destination); assert.equal(plan.restorePanels, true);
  }
});

test('multiple timers use floats without mutating or duplicating their retained screens', () => {
  const panels = {left: panel('tea'), right: panel('pasta')}, before = structuredClone(panels);
  const plan = floatingActivityPlan({timers: [timer('tea'), timer('pasta')], now, destination: 'bothThink', panels});
  assert.equal(plan.usesFloatingBody, true); assert.deepEqual(plan.physicalPanels, {left: null, right: null});
  assert.deepEqual(ids(plan.cards), ['timer:tea', 'timer:pasta']); assert.deepEqual(panels, before);
  assert.equal(plan.destination, 'bodyThink'); assert.equal(plan.restorePanels, false);
});

test('timer plus music use floats while unrelated service screens remain intact', () => {
  const oven = {type: 'oven', status: 'offline'};
  const plan = floatingActivityPlan({timers: [timer('tea')], spotify, now, destination: 'both', panels: {left: panel('tea'), right: oven}});
  assert.equal(plan.usesFloatingBody, true); assert.deepEqual(ids(plan.cards), ['timer:tea', 'music:spotify']);
  assert.equal(plan.physicalPanels.left, null); assert.equal(plan.physicalPanels.right, oven);
  assert.equal(plan.destination, 'right'); assert.equal(plan.restorePanels, false);
});

test('multiple floating activities use neutral body poses without restoring hidden screens', () => {
  const timers = [timer('one'), timer('two')], panels = {left: panel('one'), right: panel('two')};
  for (const destination of ['ready', 'left', 'right', 'both', 'seatedLeft', 'seatedRight', 'ceiling', 'walk', 'dance', 'toss']) {
    const plan = floatingActivityPlan({timers, now, panels, destination});
    assert.equal(plan.destination, 'ready'); assert.equal(plan.restorePanels, false);
    const thinking = floatingActivityPlan({timers, now, panels, destination: `${destination}Think`});
    assert.equal(thinking.destination, 'bodyThink'); assert.equal(thinking.restorePanels, false);
  }
  for (const destination of ['face', 'faceThink', 'camera', 'search']) {
    const plan = floatingActivityPlan({timers, now, panels, destination});
    assert.equal(plan.destination, destination); assert.equal(plan.restorePanels, true);
  }
});

test('surviving service panels keep matching seated and ceiling contexts beside floating activities', () => {
  const timers = [timer('one'), timer('two')];
  for (const [destination, panels, expected] of [
    ['seatedLeft', {left: {type: 'oven'}}, 'seatedLeft'],
    ['seatedRightThink', {right: {type: 'oven'}}, 'seatedRightThink'],
    ['ceilingThink', {right: {type: 'lights'}}, 'ceilingThink'],
    ['ceiling', {left: {type: 'oven'}, right: panel('one')}, 'left'],
    ['bothThink', {left: {type: 'oven'}, right: panel('one')}, 'leftThink'],
    ['both', {left: panel('one'), right: {type: 'lights'}}, 'right'],
    ['right', {left: {type: 'oven'}, right: {type: 'lights'}}, 'both'],
    ['bodyThink', {left: {type: 'oven'}, right: {type: 'lights'}}, 'bothThink'],
  ]) {
    const plan = floatingActivityPlan({timers, now, panels, destination});
    assert.equal(plan.destination, expected); assert.equal(plan.restorePanels, false);
    assert.equal(Object.values(plan.physicalPanels).filter(Boolean).every(p => !['timer', 'music'].includes(p.type)), true);
  }
});

test('bounded display retains finished timers and music, with every omitted activity in overflow', () => {
  const plan = floatingActivityPlan({timers: [timer('one'), timer('two'), timer('three'), timer('done', {status: 'completed'})],
    spotify, now, destination: 'face', maxCards: 3});
  assert.deepEqual(ids(plan.cards), ['timer:done', 'timer:one', 'music:spotify']);
  assert.deepEqual(ids(plan.overflow), ['timer:two', 'timer:three']); assert.equal(plan.overflowCount, 2);
  assert.equal(new Set([...ids(plan.cards), ...ids(plan.overflow)]).size, plan.activities.length);
  const tiny = floatingActivityPlan({timers: [timer('one')], spotify, maxCards: 1});
  assert.deepEqual(ids(tiny.cards), ['timer:one']); assert.equal(tiny.overflowCount, 1);
  const rail = floatingActivityPlan({timers: [timer('one'), timer('two'), timer('three')], spotify, now, maxCards: Number.MAX_SAFE_INTEGER});
  assert.equal(rail.cards.length, 4); assert.equal(rail.overflowCount, 0);
});

test('cancelling back to one timer restores the same physical identity and disconnect removes music', () => {
  const panels = {left: panel('tea'), right: panel('pasta')};
  const many = floatingActivityPlan({timers: [timer('tea'), timer('pasta')], now, destination: 'both', panels});
  assert.equal(many.usesFloatingBody, true);
  const one = floatingActivityPlan({timers: [timer('tea'), timer('pasta', {status: 'cancelled'})], now, destination: 'left', panels});
  assert.equal(one.usesFloatingBody, false); assert.equal(one.physicalPanels.left.id, 'tea'); assert.deepEqual(one.cards, []);
  const stopped = floatingActivityPlan({timers: [], spotify: {connected: false}, destination: 'face'});
  assert.deepEqual(stopped.activities, []); assert.equal(stopped.overflowCount, 0);
});
