import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chooseClockSpot, clockAnchors, clockMotionPlan, overlapArea} from '../clock-layout.js';
import {chooseOverlaySpot, companionOverlayRail} from './layout.js';
import {normalizeOverlay, formatOverlayDuration} from './model.js';

const size = {width: 1000, height: 750, cardWidth: 270, cardHeight: 145};
const manifest = JSON.parse(readFileSync(new URL('../../states.json', import.meta.url)));
const footprints = JSON.parse(readFileSync(new URL('../motion-footprints.json', import.meta.url))).clips;
const pixelRect = spot => ({left: spot.x, top: spot.y, right: spot.x + spot.width, bottom: spot.y + spot.height});

test('companion rails stay outside central facial features and the neutral body at narrow and wide sizes', () => {
  for (const width of [288, 358, 720, 1200]) {
    const height = width * .75;
    const face = companionOverlayRail({width, height, mode: 'face'});
    assert.ok(face.x > 0 && face.x + face.width < width);
    assert.ok(height - face.bottom - face.maxHeight > height * .77, 'face rail stays below eyes and mouth');
    assert.ok(face.width <= width * .42 && face.maxHeight <= height * .2);
    const body = companionOverlayRail({width, height});
    assert.ok(body.x > width * .65, 'body rail stays right of neutral robot');
    assert.ok(body.maxHeight < height && body.bottom > 0);
  }
  for (const value of [0, -1, NaN, Infinity, '300']) assert.equal(companionOverlayRail({width: value, height: 100}), null);
  assert.equal(companionOverlayRail({width: 300, height: 200, mode: 'hidden'}), null);
});

test('body rails choose the clear corner beside the robot and opposite the retained clock anchor', () => {
  const stage = {width: 1000, height: 750};
  assert.equal(companionOverlayRail({...stage, clock: {x: 720, y: 30, width: 220, height: 100}}).id, 'lower-left');
  assert.equal(companionOverlayRail({...stage, clock: {x: 30, y: 30, width: 220, height: 100}}).id, 'lower-right');
  assert.equal(companionOverlayRail({...stage, obstacles: [{left: .65, top: .2, right: 1, bottom: 1}]}).id, 'lower-left');
  assert.equal(companionOverlayRail({...stage, obstacles: [{left: 0, top: .2, right: .35, bottom: 1}]}).id, 'lower-right');
  assert.equal(companionOverlayRail({...stage, current: 'lower-left'}).id, 'lower-left', 'an unconstrained corner stays stable');
  assert.equal(companionOverlayRail({...stage, mode: 'face', clock: {x: 720, y: 30, width: 220, height: 100}}).id, 'lower-right');
});

test('fresh overlays contain no sample values and never infer successful state from a duration', () => {
  assert.deepEqual(normalizeOverlay('timer'), {type: 'timer', title: 'Timer', status: 'unknown', remainingSeconds: null, durationSeconds: null});
  assert.deepEqual(normalizeOverlay('music'), {type: 'music', title: 'Music', artist: '', status: 'unknown', positionSeconds: null, durationSeconds: null});
  assert.equal(normalizeOverlay('timer', {seconds: 0}).status, 'unknown');
  assert.equal(normalizeOverlay('music', {elapsed: 10, duration: 100}).status, 'unknown');
  for (const status of ['pending', 'offline', 'cancelled', 'surprise', undefined]) assert.equal(normalizeOverlay('timer', {status}).status, 'unknown');
  assert.equal(normalizeOverlay('music', {status: 'offline'}).status, 'unknown');
  assert.equal(normalizeOverlay('music', {status: 'surprise'}).status, 'unknown');
});

test('existing panel data and explicit overlay data normalize without changing caller records', () => {
  const timer = {type: 'music', label: 'Tea <timer>', status: 'done', seconds: 0, durationSeconds: 300};
  const before = structuredClone(timer);
  assert.deepEqual(normalizeOverlay('timer', timer), {type: 'timer', title: 'Tea <timer>', status: 'finished', remainingSeconds: 0, durationSeconds: 300});
  assert.deepEqual(timer, before);
  assert.equal(normalizeOverlay('timer', {status: 'completed'}).status, 'finished');
  assert.equal(normalizeOverlay('timer', {title: 'Explicit', label: 'Alias', remainingSeconds: 0, seconds: 50}).title, 'Explicit');
  assert.equal(normalizeOverlay('timer', {remainingSeconds: 0, seconds: 50}).remainingSeconds, 0);
  assert.equal(normalizeOverlay('timer', {remainingSeconds: null, seconds: 50}).remainingSeconds, null, 'explicit missing data cannot revive a stale alias');
  assert.deepEqual(normalizeOverlay('music', {title: 'Track', artist: 'Artist', status: 'paused', elapsed: 12.5, duration: 218}),
    {type: 'music', title: 'Track', artist: 'Artist', status: 'paused', positionSeconds: 12.5, durationSeconds: 218});
  const explicit = normalizeOverlay('music', {positionSeconds: 0, elapsed: 45, durationSeconds: 100, duration: 200});
  assert.equal(explicit.positionSeconds, 0); assert.equal(explicit.durationSeconds, 100);
  assert.equal(normalizeOverlay('music', {positionSeconds: null, elapsed: 45}).positionSeconds, null);
  assert.equal(normalizeOverlay('music', {durationSeconds: null, duration: 45}).durationSeconds, null);
  assert.equal(normalizeOverlay('music', {status: 'empty'}).status, 'stopped');
  assert.equal(normalizeOverlay('music', {status: 'pending'}).status, 'loading');
});

test('invalid numbers stay missing, valid timer limits and literal text survive', () => {
  for (const value of [undefined, null, '', '20', NaN, Infinity, -Infinity, -1, 604800.1]) {
    const timer = normalizeOverlay('timer', {remainingSeconds: value, durationSeconds: value});
    assert.equal(timer.remainingSeconds, null); assert.equal(timer.durationSeconds, null);
  }
  for (const value of [0, .1, 604800]) assert.equal(normalizeOverlay('timer', {remainingSeconds: value}).remainingSeconds, value);
  for (const value of [NaN, Infinity, -1, '15', Number.MAX_SAFE_INTEGER + 1]) {
    const music = normalizeOverlay('music', {positionSeconds: value, durationSeconds: value});
    assert.equal(music.positionSeconds, null); assert.equal(music.durationSeconds, null);
  }
  const literal = '<img src=x onerror=alert(1)> & “Tea”';
  assert.equal(normalizeOverlay('timer', {title: literal}).title, literal);
  assert.equal(normalizeOverlay('music', {title: 42, artist: false}).title, '42');
  assert.equal(normalizeOverlay('music', {artist: false}).artist, 'false');
  assert.equal(normalizeOverlay('music', {title: {toString() {throw Error('No text');}}}).title, 'Music');
  for (const type of [undefined, null, 'clock', 'lights', '__proto__']) assert.throws(() => normalizeOverlay(type), TypeError);
  for (const data of [null, [], 12, 'timer']) assert.throws(() => normalizeOverlay('timer', data), TypeError);
});

test('duration formatting preserves zero, rounds partial seconds and never wraps long timers', () => {
  for (const [value, expected] of [[0, '0:00'], [.1, '0:01'], [59.1, '1:00'], [300, '5:00'], [3599, '59:59'], [3600, '1:00:00'], [3661, '1:01:01'], [604800, '168:00:00']]) {
    assert.equal(formatOverlayDuration(value), expected);
  }
  for (const value of [null, undefined, '', '0', NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) assert.equal(formatOverlayDuration(value), '—');
});

test('cards reserve the clock and each other while safe spots remain stable', () => {
  const clock = chooseClockSpot({...size, clockWidth: 270, clockHeight: 110});
  const first = chooseOverlaySpot({...size, reserved: [clock]});
  const second = chooseOverlaySpot({...size, reserved: [pixelRect(clock), pixelRect(first)]});
  assert.ok(first && second); assert.notEqual(first.id, clock.id); assert.notEqual(second.id, first.id);
  for (const [a, b] of [[clock, first], [clock, second], [first, second]]) assert.equal(overlapArea(pixelRect(a), pixelRect(b)), 0);
  assert.equal(chooseOverlaySpot({...size, current: second.id}).id, second.id, 'removing other cards does not cause needless movement');
  assert.equal(chooseClockSpot({...size, clockWidth: 270, clockHeight: 110}).id, clock.id, 'overlay planning does not alter clock state');
});

test('reserved pixels use one clearance margin rather than double padding', () => {
  const anchors = clockAnchors(size.width, size.height, size.cardWidth, size.cardHeight);
  const target = anchors[1], gap = Math.min(size.width, size.height) * .018;
  const blockers = anchors.filter(spot => spot.id !== target.id).map(pixelRect);
  blockers.push({left: target.x - 20, right: target.x - gap - .1, top: target.y, bottom: target.y + target.height});
  const result = chooseOverlaySpot({...size, reserved: blockers});
  assert.equal(result?.id, target.id);
  blockers.at(-1).right = target.x - gap + .1;
  assert.equal(chooseOverlaySpot({...size, reserved: blockers}), null, 'less than the single clearance is unsafe');
});

test('occupied, invalid and oversized stages cannot return unsafe cards', () => {
  assert.equal(chooseOverlaySpot({...size, obstacles: [{left: 0, top: 0, right: 1, bottom: 1}]}), null);
  assert.equal(chooseOverlaySpot({...size, reserved: clockAnchors(size.width, size.height, size.cardWidth, size.cardHeight)}), null);
  for (const key of ['width', 'height', 'cardWidth', 'cardHeight']) for (const value of [0, -1, NaN, Infinity, '300']) {
    assert.equal(chooseOverlaySpot({...size, [key]: value}), null, `${key}=${value}`);
  }
  for (const override of [{cardWidth: 1000}, {cardHeight: 750}, {width: 30}, {height: 30}, {reserved: [{}]}, {reserved: null}, {obstacles: [{}]}, {obstacles: null}]) {
    assert.equal(chooseOverlaySpot({...size, ...override}), null);
  }
  assert.equal(chooseOverlaySpot(), null);
});

test('current exported body routes reserve real geometry and permit multiple cards only where safe', () => {
  for (const width of [288, 358, 1000, 1200]) {
    const height = width * .75, cardWidth = width * .27, cardHeight = width * .145;
    for (const [state, definition] of Object.entries(manifest.states)) {
      const plan = clockMotionPlan({current: state, desired: state, phase: 'idle', clip: definition.idle}, manifest.states, manifest.routes);
      if (plan.hidden) continue;
      const obstacles = plan.occlusionClips.flatMap(clip => footprints[clip] || []);
      const clock = chooseClockSpot({width, height, clockWidth: width * .27, clockHeight: width * .11, obstacles});
      const reserved = [clock], placed = [];
      for (let i = 0; i < 2; i++) {
        const result = chooseOverlaySpot({width, height, cardWidth, cardHeight, obstacles, reserved});
        if (!result) break;
        assert.equal(result.overlap, 0, `${width}px ${state}`);
        assert.ok(result.x > 0 && result.y > 0 && result.x + result.width < width && result.y + result.height < height);
        const rect = pixelRect(result);
        for (const previous of reserved) assert.equal(overlapArea(rect, pixelRect(previous)), 0);
        for (const obstacle of obstacles) assert.equal(overlapArea(rect, {left: obstacle.left * width, right: obstacle.right * width, top: obstacle.top * height, bottom: obstacle.bottom * height}), 0);
        reserved.push(result); placed.push(result);
      }
      if (['ready', 'walk', 'walkReverse', 'toss', 'nap'].includes(state)) assert.equal(placed.length, 2, `${width}px ${state} supports the requested pair`);
      if (['left', 'right', 'leftThink', 'rightThink'].includes(state)) assert.equal(placed.length, 0, `${width}px ${state} keeps the clock's sole clear slot`);
      if (['both', 'bothThink'].includes(state)) assert.equal(placed.length, 1, `${width}px ${state} has room for one optional card`);
    }
  }
});
