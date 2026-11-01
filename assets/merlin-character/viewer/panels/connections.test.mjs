import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROBOT_ZONE, connectionsLayout, connectionTargets, connectionsDescription, paintConnections, pageCount, pageSize,
} from './connections.js';

// The ceiling card in the authored scene is landscape at about 1.41:1; side panels are 5:6.
const CEILING = {width: 1528, height: 1080};
const PORTRAIT = {width: 900, height: 1080};

const tile = (id, over = {}) => ({id, name: `Route ${id}`, sub: 'Company', difficulty: 'easy', status: 'available', ...over});
const categories = [{id: 'all', label: 'All'}, {id: 'lights', label: 'Lights', active: true}, {id: 'cameras', label: 'Cameras'}, {id: 'climate', label: 'Climate'},
  {id: 'appliances', label: 'Appliances'}, {id: 'locks', label: 'Locks'}, {id: 'music', label: 'Music'}, {id: 'hubs', label: 'Hubs'}];
const browse = (count, over = {}) => ({type: 'connections', view: 'browse', categories, page: 0, tiles: Array.from({length: count}, (_, i) => tile(i + 1, {difficulty: ['easy', 'medium', 'hard'][i % 3], status: i === 1 ? 'connected' : i === 4 ? 'unavailable' : 'available'})), ...over});
const setup = (over = {}) => ({type: 'connections', view: 'setup', setup: {id: 'ring', name: 'Ring', difficulty: 'medium', reason: 'Needs a supported camera route.', available: true, connected: false, disconnectable: true,
  requirements: ['A Ring account', 'A supported Ring device', 'Permission from the account owner'], limitations: ['No device control yet'], steps: ['Check your devices', 'Add the integration', 'Review the controls', 'Done'], guideUrl: 'https://example.org/guide', ...over}});

function recordingCanvas() {
  const texts = []; let depth = 0;
  const ctx = {
    texts, font: '32px sans-serif',
    save() { depth++; }, restore() { depth--; assert.ok(depth >= 0); },
    measureText(value) { return {width: String(value).length * (Number.parseFloat(this.font.match(/[\d.]+px/)?.[0]) || 32) * .52}; },
    fillText(value) { texts.push(String(value)); }, get depth() { return depth; },
  };
  for (const method of ['beginPath', 'roundRect', 'fill', 'stroke', 'moveTo', 'lineTo', 'fillRect', 'arc', 'closePath']) {
    ctx[method] = (...values) => { for (const value of values) if (typeof value === 'number') assert.ok(Number.isFinite(value), `${method} receives finite coordinates`); };
  }
  return ctx;
}

const inside = (rect, width, height) => rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= width && rect.y + rect.h <= height;
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('no tap target overlaps the robot or leaves the ceiling card', () => {
  const {width, height} = CEILING;
  const robot = {x: ROBOT_ZONE.x0 * width, y: ROBOT_ZONE.y0 * height, w: (ROBOT_ZONE.x1 - ROBOT_ZONE.x0) * width, h: height};
  for (const state of [browse(0), browse(3), browse(6), browse(40), browse(40, {page: 3}), browse(40, {page: 99}), setup(), setup({connected: true}), setup({available: false}), setup({guideUrl: ''})]) {
    const targets = connectionTargets(state, width, height);
    assert.ok(targets.length > 0);
    for (const target of targets) {
      assert.ok(inside(target, width, height), `${target.id} stays on the card`);
      assert.ok(!overlaps(target, robot), `${target.id} stays out of the robot's footprint`);
      assert.ok(target.w >= 90 && target.h >= 60, `${target.id} is large enough to tap`);
    }
    // Everything drawn avoids the robot too, not just the buttons.
    for (const item of connectionsLayout(state, width, height)) {
      if (item.w === undefined || item.kind === 'title' || item.kind === 'subtitle') continue;
      assert.ok(!overlaps(item, robot), `${item.kind} is clear of the robot`);
    }
  }
});

test('targets are unique and carry names a screen reader can use', () => {
  const targets = connectionTargets(browse(6), CEILING.width, CEILING.height);
  assert.equal(new Set(targets.map(target => target.id)).size, targets.length);
  for (const target of targets) assert.ok(target.label.length > 3 && target.label.length < 160, target.label);
  assert.ok(targets.some(target => target.action === 'category' && target.value === 'lights' && /selected/.test(target.label)));
  assert.ok(targets.some(target => /connected as a preview/.test(target.label)), 'a connected tile says it is only a preview');
  assert.ok(targets.some(target => /unavailable/.test(target.label)));
});

test('only easy, available, unconnected tiles get the quick Connect target', () => {
  const targets = connectionTargets(browse(6), CEILING.width, CEILING.height);
  const quick = targets.filter(target => target.action === 'connect').map(target => target.value);
  assert.deepEqual(quick, [1, 4], 'tiles 1 and 4 are the easy ones that are available and unconnected');
  const spotify = browse(1, {tiles: [tile('spotify', {real: true})]});
  assert.equal(connectionTargets(spotify, CEILING.width, CEILING.height).some(target => target.action === 'connect'), false, 'Spotify uses its own setup');
});

test('paging shows six tiles per ceiling page and clamps the page', () => {
  assert.equal(pageSize(CEILING.width, CEILING.height), 6);
  assert.equal(pageSize(PORTRAIT.width, PORTRAIT.height), 5);
  assert.equal(pageCount(browse(13), CEILING.width, CEILING.height), 3);
  assert.equal(pageCount(browse(0), CEILING.width, CEILING.height), 1);
  const second = connectionTargets(browse(13, {page: 1}), CEILING.width, CEILING.height).filter(target => target.action === 'open').map(target => target.value);
  assert.deepEqual(second, [7, 8, 9, 10, 11, 12]);
  const last = connectionTargets(browse(13, {page: 50}), CEILING.width, CEILING.height).filter(target => target.action === 'open').map(target => target.value);
  assert.deepEqual(last, [13], 'an out-of-range page shows the last page');
  const pagerActions = connectionTargets(browse(13), CEILING.width, CEILING.height).filter(target => target.action === 'page');
  assert.deepEqual(pagerActions.map(target => target.value), [1], 'Previous is disabled on the first page');
  assert.equal(connectionTargets(browse(5), CEILING.width, CEILING.height).some(target => target.action === 'page'), false, 'no pager for a single page');
});

test('the setup view offers back, connect or disconnect, and the official guide', () => {
  const actions = state => connectionTargets(state, CEILING.width, CEILING.height).map(target => target.action);
  assert.deepEqual(actions(setup()), ['back', 'connect', 'guide']);
  assert.deepEqual(actions(setup({connected: true})), ['back', 'disconnect', 'guide']);
  assert.deepEqual(actions(setup({available: false})), ['back', 'guide'], 'an unavailable route cannot be connected');
  assert.deepEqual(actions(setup({connected: true, disconnectable: false})), ['back', 'guide'], 'Spotify cannot be disconnected from here');
  const real = connectionTargets(setup({real: true, name: 'Spotify'}), CEILING.width, CEILING.height).find(target => target.action === 'connect');
  assert.match(real.label, /Spotify/);
});

test('drawing is balanced, finite, labelled as a preview, and stays inside the card for every view and aspect', () => {
  for (const [name, size] of [['ceiling', CEILING], ['portrait', PORTRAIT], ['tall', {width: 600, height: 1080}]]) {
    for (const state of [browse(0), browse(7), browse(40, {page: 2}), setup(), setup({connected: true}), browse(3, {notice: 'Connected Route 1 as a preview.'})]) {
      const ctx = recordingCanvas();
      paintConnections(ctx, size.width, size.height, state);
      assert.equal(ctx.depth, 0, `${name}: painter restores its canvas`);
      assert.ok(ctx.texts.length > 0);
      assert.ok(ctx.texts.some(value => /Preview|preview/.test(value)), `${name}: says it is a preview`);
      for (const target of connectionTargets(state, size.width, size.height)) assert.ok(inside(target, size.width, size.height), `${name}: ${target.id}`);
    }
  }
});

test('descriptions never claim a real connection', () => {
  assert.match(connectionsDescription(browse(4)), /Previews record a choice only/);
  assert.match(connectionsDescription(setup({connected: true})), /Connected as a preview/);
  assert.match(connectionsDescription(setup({connected: true, real: true})), /Connected\./);
});

test('long names and many requirements are truncated rather than overflowing', () => {
  const long = setup({name: 'A'.repeat(200), requirements: ['word '.repeat(80), 'x', 'y', 'z'], steps: Array.from({length: 9}, (_, i) => `Step number ${i + 1} ${'long '.repeat(30)}`)});
  const ctx = recordingCanvas();
  paintConnections(ctx, CEILING.width, CEILING.height, long);
  assert.equal(ctx.depth, 0);
  assert.ok(ctx.texts.every(value => value.length < 400));
  assert.equal(connectionTargets(long, CEILING.width, CEILING.height).length, 3);
});
