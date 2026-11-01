import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROBOT_ZONE, connectionsLayout, connectionTargets, connectionsDescription, paintConnections, pageCount, pageSize,
} from './connections.js';

// The ceiling card in the authored scene is landscape at about 1.41:1; side panels are 5:6.
const CEILING = {width: 1528, height: 1080};
const PORTRAIT = {width: 900, height: 1080};

const tile = (id, over = {}) => ({id, name: `Route ${id}`, sub: 'Company', difficulty: 'easy', status: 'available', type: 'native', ...over});
const STATUSES = ['available', 'connected', 'saved', 'attention', 'guide', 'none', 'unavailable'];
const categories = [{id: 'all', label: 'All'}, {id: 'lights', label: 'Lights', active: true}, {id: 'cameras', label: 'Cameras'}, {id: 'climate', label: 'Climate'},
  {id: 'appliances', label: 'Appliances'}, {id: 'locks', label: 'Locks'}, {id: 'music', label: 'Music'}, {id: 'hubs', label: 'Hubs'}];
const browse = (count, over = {}) => ({type: 'connections', view: 'browse', categories, page: 0, tiles: Array.from({length: count}, (_, i) => tile(i + 1, {difficulty: ['easy', 'medium', 'hard'][i % 3], status: STATUSES[i % STATUSES.length]})), ...over});
const setup = (over = {}) => ({type: 'connections', view: 'setup', setup: {id: 'philips-hue', name: 'Philips Hue', difficulty: 'easy', type: 'native', via: '', status: 'available', real: false, summary: 'Not connected yet.',
  requirements: ['A Hue Bridge on the same network.', 'Physical access to the bridge to press its link button.', 'A third requirement that will not be drawn'], limitations: ['Works over your home network only.'],
  steps: ['Find the bridge', 'Save the address', 'Press the link button, then Pair', 'A fourth step'], guideUrl: 'https://example.org/guide', busy: '', confirmDisconnect: false,
  afterwards: 'MERLIN can list your lights, rooms and scenes, turn them on or off, dim them and recall a scene.', remaining: 'Not yet supported: sensors, entertainment areas and the older round bridge.', ...over}});
const SETUPS = [setup(), setup({status: 'saved'}), setup({status: 'connected'}), setup({status: 'connected', confirmDisconnect: true}), setup({status: 'connected', busy: 'verify'}), setup({status: 'attention', summary: 'Philips Hue did not accept the saved credentials. Reconnect it on the Connection Center page.'}),
  setup({status: 'unavailable'}), setup({type: 'via-home-assistant', via: 'home-assistant', status: 'guide', name: 'Sonos'}), setup({type: 'none', status: 'none', name: 'myQ', guideUrl: ''}),
  setup({real: true, name: 'Spotify', status: 'connected'}), setup({real: true, name: 'Spotify', status: 'available'}), setup({guideUrl: ''})];

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
  for (const state of [browse(0), browse(3), browse(6), browse(40), browse(40, {page: 3}), browse(40, {page: 99}), ...SETUPS]) {
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
      assert.ok(inside(item, width, height), `${item.kind} stays on the card`);
    }
  }
});

test('on narrower cards everything drawn stays on the card, even when the action row wraps', () => {
  for (const size of [PORTRAIT, {width: 600, height: 1080}, {width: 1100, height: 1080}]) {
    for (const state of [browse(0), browse(6), ...SETUPS]) {
      for (const item of connectionsLayout(state, size.width, size.height)) {
        if (item.w === undefined || item.kind === 'title' || item.kind === 'subtitle') continue;
        assert.ok(inside(item, size.width, size.height), `${size.width}: ${item.kind} ${item.heading || item.text || ''} stays on the card`);
      }
      const overlapping = connectionsLayout(state, size.width, size.height).filter(item => item.kind === 'note' || item.kind === 'list');
      for (let i = 1; i < overlapping.length; i++) assert.ok(overlapping[i].y >= overlapping[i - 1].y + overlapping[i - 1].h - 1, `${size.width}: blocks do not overlap`);
    }
  }
});

test('the action row never wraps on the ceiling card, so nothing is pushed into the lists or the robot', () => {
  for (const state of SETUPS) {
    const rows = new Set(connectionsLayout(state, CEILING.width, CEILING.height).filter(item => item.kind === 'button').map(item => item.y));
    assert.equal(rows.size, 1, `${state.setup.name} ${state.setup.status}: one row of buttons`);
  }
});

test('targets are unique, carry names a screen reader can use, and never call anything a preview', () => {
  const targets = connectionTargets(browse(7), CEILING.width, CEILING.height);
  assert.equal(new Set(targets.map(target => target.id)).size, targets.length);
  for (const target of targets) assert.ok(target.label.length > 3 && target.label.length < 200, target.label);
  assert.ok(targets.some(target => target.action === 'category' && target.value === 'lights' && /selected/.test(target.label)));
  assert.ok(targets.some(target => /connected and verified/.test(target.label)), 'a connected tile says it is verified');
  assert.ok(targets.some(target => /setup unfinished, not usable yet/.test(target.label)));
  assert.ok(targets.some(target => /needs attention/.test(target.label)));
  assert.ok(targets.some(target => /setup guide only, works through Home Assistant/.test(target.label)));
  assert.ok(targets.some(target => /not supported/.test(target.label)));
  assert.ok(targets.some(target => /not connected, can be set up/.test(target.label)));
  for (const state of [browse(12), ...SETUPS]) for (const target of connectionTargets(state, CEILING.width, CEILING.height)) assert.doesNotMatch(target.label, /preview|demo|simulat/i, target.label);
});

test('tiles open details only: connecting happens on the Connection Center page, never from a tile', () => {
  const targets = connectionTargets(browse(6), CEILING.width, CEILING.height);
  assert.deepEqual([...new Set(targets.filter(target => target.id.includes(':') && /^open:/.test(target.id)).map(target => target.action))], ['open']);
  assert.equal(targets.some(target => ['connect', 'setup', 'verify', 'disconnect'].includes(target.action)), false);
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

test('the setup view offers only the actions that are real for the service and its status', () => {
  const actions = state => connectionTargets(state, CEILING.width, CEILING.height).map(target => target.action);
  assert.deepEqual(actions(setup()), ['back', 'setup', 'guide'], 'a real service that is not set up opens its setup page');
  assert.deepEqual(actions(setup({status: 'saved'})), ['back', 'setup', 'guide'], 'saved settings still need finishing');
  assert.deepEqual(actions(setup({status: 'connected'})), ['back', 'verify', 'disconnect', 'guide']);
  assert.deepEqual(actions(setup({status: 'attention'})), ['back', 'setup', 'verify', 'guide'], 'reconnect or check again');
  assert.deepEqual(actions(setup({status: 'connected', busy: 'verify'})), ['back', 'guide'], 'no second request while one is running');
  assert.deepEqual(actions(setup({status: 'unavailable'})), ['back', 'guide']);
  assert.deepEqual(actions(setup({type: 'via-home-assistant', via: 'home-assistant', status: 'guide'})), ['back', 'open', 'guide'], 'a guide never offers to connect');
  assert.deepEqual(actions(setup({type: 'none', status: 'none'})), ['back', 'guide']);
  assert.deepEqual(actions(setup({type: 'none', status: 'none', guideUrl: ''})), ['back']);
  assert.deepEqual(actions(setup({real: true, name: 'Spotify', status: 'available'})), ['back', 'setup', 'guide']);
  assert.deepEqual(actions(setup({real: true, name: 'Spotify', status: 'connected'})), ['back', 'setup', 'disconnect', 'guide'], 'Spotify has no verify here');
  const via = connectionTargets(setup({type: 'via-home-assistant', via: 'home-assistant', status: 'guide'}), CEILING.width, CEILING.height).find(target => target.action === 'open');
  assert.equal(via.value, 'home-assistant');
  const confirm = connectionTargets(setup({status: 'connected', confirmDisconnect: true}), CEILING.width, CEILING.height).find(target => target.action === 'disconnect');
  assert.match(confirm.label, /Tap again to disconnect/);
  assert.match(connectionTargets(setup({real: true, name: 'Spotify'}), CEILING.width, CEILING.height).find(target => target.action === 'setup').label, /Spotify/);
});

test('drawing is balanced, finite, states the real status, and stays inside the card for every view and aspect', () => {
  for (const [name, size] of [['ceiling', CEILING], ['portrait', PORTRAIT], ['tall', {width: 600, height: 1080}]]) {
    for (const state of [browse(0), browse(7), browse(40, {page: 2}), ...SETUPS, browse(3, {notice: 'Philips Hue is connected and verified.'})]) {
      const ctx = recordingCanvas();
      paintConnections(ctx, size.width, size.height, state);
      assert.equal(ctx.depth, 0, `${name}: painter restores its canvas`);
      assert.ok(ctx.texts.length > 0);
      assert.ok(ctx.texts.every(value => !/preview/i.test(value)), `${name}: nothing is called a preview`);
      if (!state.notice) assert.ok(ctx.texts.some(value => /Connection Center/.test(value)), `${name}: says where real connections are made`);
      for (const target of connectionTargets(state, size.width, size.height)) assert.ok(inside(target, size.width, size.height), `${name}: ${target.id}`);
    }
  }
  const connected = recordingCanvas();
  paintConnections(connected, CEILING.width, CEILING.height, setup({status: 'connected'}));
  assert.ok(connected.texts.some(value => /Connected ✓/.test(value)));
  const guide = recordingCanvas();
  paintConnections(guide, CEILING.width, CEILING.height, setup({type: 'via-home-assistant', via: 'home-assistant', status: 'guide'}));
  assert.ok(guide.texts.every(value => !/Connected ✓/.test(value)), 'a guide never looks connected');
  assert.ok(guide.texts.some(value => /What MERLIN can do/.test(value)) && guide.texts.some(value => /What’s missing/.test(value)));
});

test('descriptions state the real status and where connecting happens', () => {
  assert.match(connectionsDescription(browse(4)), /Connection Center page/);
  assert.doesNotMatch(connectionsDescription(browse(4)), /preview/i);
  assert.match(connectionsDescription(setup({status: 'connected'})), /Connected and verified/);
  assert.match(connectionsDescription(setup({status: 'saved'})), /Setup unfinished/);
  assert.match(connectionsDescription(setup({type: 'via-home-assistant', status: 'guide'})), /setup guide only/i);
});

test('long names and many requirements are truncated rather than overflowing', () => {
  const long = setup({name: 'A'.repeat(200), requirements: ['word '.repeat(80), 'x', 'y', 'z'], steps: Array.from({length: 9}, (_, i) => `Step number ${i + 1} ${'long '.repeat(30)}`), afterwards: 'sentence '.repeat(120), remaining: 'missing '.repeat(120), summary: 'words '.repeat(60)});
  const ctx = recordingCanvas();
  paintConnections(ctx, CEILING.width, CEILING.height, long);
  assert.equal(ctx.depth, 0);
  assert.ok(ctx.texts.every(value => value.length < 400));
  assert.equal(connectionTargets(long, CEILING.width, CEILING.height).length, 3);
});
