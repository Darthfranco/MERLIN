import assert from 'node:assert/strict';
import test from 'node:test';
import { SPOTIFY, applyAction, chipCategories, connectorSummary, initialUi, panelState, routeName } from '../public/companion/connections-panel.js';
import { CONNECTIONS } from '../public/connections/catalog.js';

const names = state => state.tiles.map(tile => tile.id);
const hub = (id, status, detail = '') => ({ id, name: id, status, detail, verified_at: null, external: id === 'spotify' });
const tileOf = (state, id) => state.tiles.find(tile => tile.id === id);

test('a presentation card becomes browse or setup UI state and ignores invalid input', () => {
  assert.deepEqual(initialUi({ category: 'lights' }), { view: 'browse', category: 'lights', entryId: null, query: '', page: 0, notice: '', announce: '', confirm: '', busy: '' });
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

test('a native service looks connected only when the server says it is connected and verified', () => {
  const lights = ui => panelState(ui, { connectors: [] });
  assert.equal(tileOf(lights(initialUi({ category: 'lights' })), 'philips-hue').status, 'available', 'nothing known means set up, never connected');
  for (const [status, shown] of [['not_connected', 'available'], ['saved', 'saved'], ['attention', 'attention'], ['connected', 'connected'], ['unavailable', 'unavailable'], ['bogus', 'available']]) {
    const state = panelState(initialUi({ category: 'lights' }), { connectors: [hub('philips-hue', status)] });
    assert.equal(tileOf(state, 'philips-hue').status, shown, status);
  }
  // A saved setting or a guide for another service cannot make this one look connected.
  const state = panelState(initialUi({ category: 'lights' }), { connectors: [hub('shelly', 'connected'), hub('philips-hue', 'saved')] });
  assert.equal(tileOf(state, 'philips-hue').status, 'saved');
  assert.equal(tileOf(state, 'shelly').status, 'connected');
});

test('guides and unsupported services never look connected, whatever the server lists', () => {
  const state = panelState(initialUi({ category: 'all' }), { connectors: [...CONNECTIONS.map(entry => hub(entry.id, 'connected')), hub('spotify', 'connected')] });
  for (const tile of state.tiles) {
    const entry = tile.id === 'spotify' ? SPOTIFY : CONNECTIONS.find(item => item.id === tile.id);
    if (entry.integration.type === 'native') assert.equal(tile.status, 'connected', tile.id);
    else assert.equal(tile.status, entry.integration.type === 'via-home-assistant' ? 'guide' : 'none', tile.id);
  }
  assert.equal(tileOf(panelState(initialUi({ category: 'speakers' })), 'sonos').status, 'guide');
  assert.equal(tileOf(panelState(initialUi({ category: 'garage' })), 'myq').status, 'none');
});

test('browse puts working and unfinished services first, then real setups, then easy guides', () => {
  const state = panelState(initialUi({ category: 'all' }), { connectors: [hub('switchbot', 'connected'), hub('rachio', 'attention'), hub('shelly', 'saved')] });
  const ids = names(state);
  assert.deepEqual(ids.slice(0, 3).sort(), ['rachio', 'shelly', 'switchbot'], 'live and half-finished first');
  const rank = tile => ['connected', 'attention', 'saved'].includes(tile.status) ? 0 : tile.type === 'native' ? 1 : tile.difficulty === 'easy' ? 2 : 3;
  const ranks = state.tiles.map(rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.ok(state.tiles.slice(3).filter(tile => tile.type === 'native').every(tile => tile.status === 'available'));
  const lights = panelState(initialUi({ category: 'lights' }), { connectors: [hub('shelly', 'connected')] });
  assert.ok(names(lights).includes('philips-hue') && names(lights).includes('shelly'));
  assert.equal(names(lights)[0], 'shelly');
});

test('music leads with Spotify, whose status is the real Spotify connection', () => {
  const off = panelState(initialUi({ category: 'music' }), { spotify: { connected: false } });
  assert.equal(off.tiles[0].id, 'spotify');
  assert.deepEqual([off.tiles[0].real, off.tiles[0].status], [true, 'available']);
  assert.equal(panelState(initialUi({ category: 'music' }), { spotify: { connected: true } }).tiles[0].status, 'connected', 'live Spotify status counts before the server list arrives');
  assert.equal(panelState(initialUi({ category: 'music' }), { spotify: { configured: true } }).tiles[0].status, 'saved');
  const hubbed = panelState(initialUi({ category: 'music' }), { spotify: { connected: true }, connectors: [hub('spotify', 'not_connected')] });
  assert.equal(hubbed.tiles[0].status, 'available', 'once the server list is here, it is the single source');
  const on = panelState(initialUi({ category: 'music' }), { connectors: [hub('spotify', 'connected'), hub('sonos', 'connected')] });
  assert.equal(on.tiles[0].status, 'connected');
  assert.ok(on.tiles.slice(1).every(tile => tile.status !== 'connected'), 'a stray id cannot make a speaker look connected');
  assert.equal(panelState(initialUi({ category: 'all' })).tiles[0].id, 'spotify');
});

test('a search phrase narrows the list and an unknown one shows nothing', () => {
  const ui = initialUi({ category: 'all', query: 'ring' });
  assert.ok(names(panelState(ui)).includes('ring'));
  assert.deepEqual(names(panelState(initialUi({ category: 'all', query: 'zzzz nothing' }))), []);
});

test('the setup view carries the live status, guide facts and what MERLIN can really do', () => {
  const guide = panelState(initialUi({ entry: 'sonos' }));
  assert.equal(guide.view, 'setup');
  assert.deepEqual([guide.setup.name, guide.setup.type, guide.setup.via, guide.setup.status], ['Sonos', 'via-home-assistant', 'home-assistant', 'guide']);
  assert.match(guide.setup.afterwards, /cannot control it yet/);
  assert.match(guide.setup.remaining, /no Sonos connector of its own/);
  assert.ok(guide.setup.steps.length > 0 && guide.setup.steps.every(step => typeof step === 'string'));

  const native = (status, detail) => panelState(initialUi({ entry: 'philips-hue' }), { connectors: [hub('philips-hue', status, detail)] }).setup;
  assert.equal(native('connected').summary, 'Connected and verified.');
  assert.match(native('saved').summary, /Setup unfinished/);
  assert.equal(native('attention', 'Philips Hue rejected the saved credentials.').summary, 'Philips Hue rejected the saved credentials.');
  assert.equal(native('not_connected').status, 'available');
  assert.match(native('connected').afterwards, /lights, rooms and scenes/);

  const myq = panelState(initialUi({ entry: 'myq' })).setup;
  assert.deepEqual([myq.type, myq.status], ['none', 'none']);
  assert.match(myq.summary, /unavailable|alternative/i);

  const spotify = panelState(initialUi({ entry: 'spotify' }), { spotify: { connected: true } }).setup;
  assert.deepEqual([spotify.real, spotify.status, spotify.type], [true, 'connected', 'native']);
  assert.equal(panelState(initialUi({ entry: 'philips-hue' }), { connectors: [] }).setup.confirmDisconnect, false);
  assert.equal(panelState({ ...initialUi({ entry: 'philips-hue' }), confirm: 'philips-hue', busy: 'verify' }).setup.confirmDisconnect, true);
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
  assert.equal(applyAction(ui, { action: 'connect', value: 'ring' }).effect, undefined, 'there is no simulated connect any more');
});

test('setup opens the Connection Center page for real services only; secrets are never handled here', () => {
  const hue = initialUi({ entry: 'philips-hue' });
  assert.deepEqual(applyAction(hue, { action: 'setup' }).effect, { type: 'open', url: '/connections/#philips-hue', name: 'Philips Hue' });
  assert.deepEqual(applyAction(initialUi({}), { action: 'setup', value: 'home-assistant' }).effect, { type: 'open', url: '/connections/#home-assistant', name: 'Home Assistant' });
  assert.equal(applyAction(initialUi({ entry: 'sonos' }), { action: 'setup' }).effect, undefined, 'a guide has nothing to set up in MERLIN');
  assert.equal(applyAction(initialUi({ entry: 'myq' }), { action: 'setup' }).effect, undefined);
  assert.equal(applyAction(initialUi({}), { action: 'setup', value: 'ghost' }).effect, undefined);
  assert.deepEqual(applyAction(initialUi({ entry: 'spotify' }), { action: 'setup' }).effect, { type: 'open', url: SPOTIFY.setupUrl, name: 'Spotify' });
  for (const route of CONNECTIONS) {
    const effect = applyAction(initialUi({ entry: route.id }), { action: 'setup' }).effect;
    if (effect) assert.equal(effect.url, `/connections/#${route.id}`);
    assert.equal(Boolean(effect), route.integration.type === 'native', route.id);
  }
});

test('verify applies to real connectors only, and disconnect needs a second tap', () => {
  const hue = initialUi({ entry: 'philips-hue' });
  assert.deepEqual(applyAction(hue, { action: 'verify' }).effect, { type: 'verify', id: 'philips-hue', name: 'Philips Hue' });
  assert.equal(applyAction(initialUi({ entry: 'spotify' }), { action: 'verify' }).effect, undefined, 'Spotify has no connector check');
  assert.equal(applyAction(initialUi({ entry: 'sonos' }), { action: 'verify' }).effect, undefined);

  const first = applyAction(hue, { action: 'disconnect' });
  assert.equal(first.effect, undefined, 'one tap only asks for confirmation');
  assert.equal(first.ui.confirm, 'philips-hue');
  assert.match(first.ui.notice, /Tap Disconnect again to remove Philips Hue/);
  assert.deepEqual(applyAction(first.ui, { action: 'disconnect' }).effect, { type: 'disconnect', id: 'philips-hue', name: 'Philips Hue' });
  assert.equal(applyAction(first.ui, { action: 'disconnect' }).ui.confirm, '');
  assert.equal(applyAction(first.ui, { action: 'back' }).ui.confirm, '', 'tapping anything else cancels the confirmation');
  assert.equal(applyAction(initialUi({ entry: 'spotify' }), { action: 'disconnect' }).ui.confirm, 'spotify');
  assert.deepEqual(applyAction({ ...initialUi({ entry: 'spotify' }), confirm: 'spotify' }, { action: 'disconnect' }).effect, { type: 'disconnect', id: 'spotify', name: 'Spotify' });
  assert.equal(applyAction(initialUi({ entry: 'sonos' }), { action: 'disconnect' }).effect, undefined);
  assert.equal(applyAction({ ...hue, confirm: 'shelly' }, { action: 'disconnect' }).effect, undefined, 'a confirmation for another service does not count');
});

test('only https official guides can be opened', () => {
  assert.match(applyAction(initialUi({ entry: 'ring' }), { action: 'guide' }).effect.url, /^https:\/\//);
  assert.equal(applyAction(initialUi({ entry: 'ghost' }), { action: 'guide' }).effect, undefined);
  for (const route of CONNECTIONS) assert.ok(!route.guideUrl || /^https:\/\//.test(route.guideUrl), `${route.id} guide must be https`);
});

test('the server record is reduced to status fields, never credentials or setup fields', () => {
  const kept = connectorSummary({ id: 'philips-hue', name: 'Philips Hue', status: 'connected', detail: 'ok', verified_at: 'x', external: false, fields: [{ name: 'bridge' }], values: { bridge: '192.168.1.2' }, secrets_saved: ['app_key'], message: 'hi' });
  assert.deepEqual(Object.keys(kept).sort(), ['detail', 'external', 'id', 'name', 'status', 'verified_at']);
});
