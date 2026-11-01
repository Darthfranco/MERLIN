import assert from 'node:assert/strict';
import test from 'node:test';
import { SPOTIFY, applyAction, chipCategories, initialUi, panelState, routeName } from '../public/companion/connections-panel.js';
import { CONNECTIONS } from '../public/connections/catalog.js';

const names = state => state.tiles.map(tile => tile.id);

test('a presentation card becomes browse or setup UI state and ignores invalid input', () => {
  assert.deepEqual(initialUi({ category: 'lights' }), { view: 'browse', category: 'lights', entryId: null, query: '', page: 0, notice: '' });
  assert.equal(initialUi({ category: 'cameras', entry: 'ring' }).view, 'setup');
  assert.equal(initialUi({ entry: 'ghost' }).view, 'browse');
  assert.equal(initialUi({ category: 'ghost' }).category, 'all');
  assert.equal(initialUi({ query: 'x'.repeat(500) }).query.length, 80);
  assert.equal(initialUi({ entry: 'spotify' }).entryId, 'spotify');
  assert.equal(routeName('ring'), 'Ring');
});

test('chips are curated, keep the active category visible, and never exceed eight', () => {
  assert.deepEqual(chipCategories('lights').map(chip => chip.id), ['all', 'lights', 'cameras', 'climate', 'appliances', 'locks', 'music', 'hubs']);
  assert.equal(chipCategories('lights').find(chip => chip.active).id, 'lights');
  const swapped = chipCategories('garage');
  assert.equal(swapped.length, 8);
  assert.equal(swapped.at(-1).id, 'garage');
  assert.equal(swapped.at(-1).active, true);
  assert.ok(chipCategories('all').every(chip => chip.label.length <= 10), 'short labels so the chips fit on one row');
});

test('browse lists a category with easy routes first, and reports preview versus unavailable status', () => {
  const state = panelState(initialUi({ category: 'lights' }), { connectedIds: ['shelly'] });
  assert.equal(state.view, 'browse');
  const ids = names(state);
  assert.ok(ids.includes('philips-hue') && ids.includes('shelly'));
  const difficulty = ids.map(id => state.tiles.find(tile => tile.id === id).difficulty);
  assert.deepEqual(difficulty, [...difficulty].sort((a, b) => ['easy', 'medium', 'hard'].indexOf(a) - ['easy', 'medium', 'hard'].indexOf(b)));
  assert.equal(state.tiles.find(tile => tile.id === 'shelly').status, 'connected');
  const garage = panelState(initialUi({ category: 'garage' }));
  assert.equal(garage.tiles.find(tile => tile.id === 'myq').status, 'unavailable');
});

test('music leads with Spotify, whose connection is real status rather than a preview', () => {
  const off = panelState(initialUi({ category: 'music' }), { spotifyConnected: false });
  assert.equal(off.tiles[0].id, 'spotify');
  assert.deepEqual([off.tiles[0].real, off.tiles[0].status], [true, 'available']);
  const on = panelState(initialUi({ category: 'music' }), { spotifyConnected: true, connectedIds: ['spotify'] });
  assert.equal(on.tiles[0].status, 'connected');
  assert.ok(on.tiles.slice(1).every(tile => tile.status !== 'connected'), 'a stray preview id cannot fake a speaker');
  assert.equal(panelState(initialUi({ category: 'all' })).tiles[0].id, 'spotify');
});

test('a search phrase narrows the list and an unknown one shows nothing', () => {
  const ui = initialUi({ category: 'all', query: 'ring' });
  assert.ok(names(panelState(ui)).includes('ring'));
  assert.deepEqual(names(panelState(initialUi({ category: 'all', query: 'zzzz nothing' }))), []);
});

test('the setup view carries guide facts and the right controls state', () => {
  const state = panelState(initialUi({ entry: 'ring' }), { connectedIds: [] });
  assert.equal(state.view, 'setup');
  assert.deepEqual([state.setup.name, state.setup.connected, state.setup.available, state.setup.disconnectable], ['Ring', false, true, false]);
  assert.ok(state.setup.steps.length > 0 && state.setup.steps.every(step => typeof step === 'string'));
  const connected = panelState(initialUi({ entry: 'ring' }), { connectedIds: ['ring'] });
  assert.deepEqual([connected.setup.connected, connected.setup.disconnectable], [true, true]);
  const myq = panelState(initialUi({ entry: 'myq' }));
  assert.equal(myq.setup.available, false);
  assert.match(myq.setup.reason, /unavailable|alternative/i);
  const spotify = panelState(initialUi({ entry: 'spotify' }), { spotifyConnected: true });
  assert.deepEqual([spotify.setup.real, spotify.setup.connected, spotify.setup.disconnectable], [true, true, false]);
});

test('taps change view, page, and category without side effects', () => {
  let ui = initialUi({ category: 'lights' });
  ui = applyAction(ui, { action: 'open', value: 'philips-hue' }).ui;
  assert.deepEqual([ui.view, ui.entryId], ['setup', 'philips-hue']);
  ui = applyAction(ui, { action: 'back' }).ui;
  assert.deepEqual([ui.view, ui.entryId], ['browse', null]);
  assert.equal(applyAction(ui, { action: 'page', value: 1 }, { pages: 3 }).ui.page, 1);
  assert.equal(applyAction({ ...ui, page: 2 }, { action: 'page', value: 1 }, { pages: 3 }).ui.page, 2, 'cannot page past the end');
  assert.equal(applyAction({ ...ui, page: 0 }, { action: 'page', value: -1 }, { pages: 3 }).ui.page, 0, 'cannot page before the start');
  ui = applyAction({ ...ui, page: 2 }, { action: 'category', value: 'cameras' }).ui;
  assert.deepEqual([ui.category, ui.page, ui.query], ['cameras', 0, '']);
  assert.equal(applyAction(ui, { action: 'category', value: 'bogus' }).ui.category, 'all');
  assert.equal(applyAction(ui, { action: 'open', value: 'ghost' }).ui, ui, 'an unknown route changes nothing');
  assert.equal(applyAction(ui, { action: 'explode' }).ui, ui);
});

test('connect and disconnect produce effects only for real catalog routes, and Spotify only opens its setup page', () => {
  const ui = initialUi({ entry: 'ring' });
  assert.deepEqual(applyAction(ui, { action: 'connect', value: 'ring' }).effect, { type: 'connect', id: 'ring', name: 'Ring' });
  assert.deepEqual(applyAction(ui, { action: 'connect' }).effect, { type: 'connect', id: 'ring', name: 'Ring' }, 'the setup button targets the open route');
  assert.deepEqual(applyAction(ui, { action: 'disconnect', value: 'ring' }).effect, { type: 'disconnect', id: 'ring', name: 'Ring' });
  assert.equal(applyAction(ui, { action: 'connect', value: 'ghost' }).effect, undefined);
  const spotify = applyAction(initialUi({ entry: 'spotify' }), { action: 'connect' });
  assert.deepEqual(spotify.effect, { type: 'open', url: SPOTIFY.setupUrl });
  assert.equal(applyAction(initialUi({ entry: 'spotify' }), { action: 'disconnect' }).effect, undefined, 'a preview disconnect cannot touch the real Spotify connection');
});

test('only https official guides can be opened', () => {
  assert.match(applyAction(initialUi({ entry: 'ring' }), { action: 'guide' }).effect.url, /^https:\/\//);
  assert.equal(applyAction(initialUi({ entry: 'ghost' }), { action: 'guide' }).effect, undefined);
  for (const route of CONNECTIONS) assert.ok(!route.guideUrl || /^https:\/\//.test(route.guideUrl), `${route.id} guide must be https`);
});
