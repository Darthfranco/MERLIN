import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { SpotifyService } from '../src/spotify.js';
import { PLAY_TAP_LINE, requestedPlaylist } from '../src/spotify-tools.js';
import { presentationResult } from '../src/companion.js';
import { Orchestrator } from '../public/companion/orchestrator.js';
import { ROBOT_ZONE } from '../assets/merlin-character/viewer/panels/connections.js';
import { playOfferDescription, playOfferLayout, playOfferTargets } from '../assets/merlin-character/viewer/panels/play-offer.js';

const reply = text => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] });

// Connected, but every Spotify call is a failure: a spoken request must never reach it.
function guardedSpotify({ connected = true } = {}) {
  const fail = () => { throw new Error('Spotify must not run from voice'); };
  return { calls: 0, status: () => ({ connected, configured: connected }), snapshot: async () => ({ connected }), control: fail, search: fail, playlists: fail };
}

async function app(t, steps, { spotify = guardedSpotify() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-playlist-offer-'));
  const calls = [];
  const meta = { configured: true, model: 'synthetic-playlist', async respond(input, tools, instructions) {
    calls.push({ tools: tools.map(tool => tool.name ?? tool.type), instructions });
    assert.ok(steps.length, 'Unexpected extra model invocation');
    return structuredClone(steps.shift());
  } };
  const created = await createApp({ dataDir: directory, meta, spotify, learningDelayMs: 60000 });
  t.after(async () => { await created.learning.close(); await rm(directory, { recursive: true, force: true }); });
  const session = randomUUID();
  const ask = async (message, channel = 'voice') => (await created.runChatTurn({ message, session_id: session, request_id: randomUUID(), time_zone: 'America/New_York', channel })).data;
  return { ask, calls, app: created };
}

test('a spoken playlist is read from the person’s own words, and nothing else counts', () => {
  for (const [message, expected] of [
    ['play my "workout" spotify playlist on the gym speakers', 'workout'],
    ['Turn on the gym lights and the gym speaker, play my workout playlist, and tell me what I am working out today.', 'workout'],
    ['play my spotify workout playlist', 'workout'],
    ['put on our Dinner Jazz playlist', 'Dinner Jazz'],
    ['play “Leg Day” playlist', 'Leg Day'],
    ['play the playlist called Workout', 'Workout'],
    ['play the playlist named Leg Day and turn on the lights', 'Leg Day'],
  ]) assert.equal(requestedPlaylist(message), expected, message);
  for (const message of ['play some music', 'What playlist should I play?', "don't play my workout playlist", 'play a playlist', 'play my playlist', 'play the playlist', 'Turn on the gym lights', '', null]) {
    assert.equal(requestedPlaylist(message), null, String(message));
  }
});

test('the offer card carries only the spoken name and a ready state', () => {
  assert.deepEqual(presentationResult('music_offer', { playlist: 'workout' }), { type: 'music-offer', id: 'spotify', query: 'workout', title: 'Workout', status: 'ready' });
  assert.equal(presentationResult('music_offer', { playlist: '  ' }), null);
  assert.equal(presentationResult('music_offer', {}), null);
});

test('a spoken playlist request puts up the Play button and ends with the tap line, without touching Spotify', async t => {
  const { ask, calls } = await app(t, [[reply('Sure thing! Today is legs: squats five by five.')]]);
  const data = await ask('Play my workout playlist and tell me what I am working out today.');
  assert.equal(calls[0].tools.some(name => name?.startsWith('spotify_')), false);
  assert.match(calls[0].instructions, /big Play button for the "workout" Spotify playlist/);
  assert.match(calls[0].instructions, /Do not mention music, Spotify or the playlist/);
  assert.equal(data.reply, `Sure thing! Today is legs: squats five by five. ${PLAY_TAP_LINE}`);
  assert.deepEqual(data.presentation, [{ type: 'music-offer', id: 'spotify', query: 'workout', title: 'Workout', status: 'ready' }]);
});

test('the tap line is never doubled when the model says it too', async t => {
  const { ask } = await app(t, [[reply(`Here you go. ${PLAY_TAP_LINE}`)]]);
  const data = await ask('play my workout playlist');
  assert.equal(data.reply, `Here you go. ${PLAY_TAP_LINE}`);
});

test('a saved routine run by voice offers the playlist it names', async t => {
  const { ask, app: created } = await app(t, [[reply('Leg day today!')]]);
  await created.routines.store.save({ name: "I'm going to the gym", aliases: [], prompt: 'Play my "workout" spotify playlist on the gym speakers and tell me what I am working out today.', source_id: 'manual', source_quote: '' });
  const data = await ask("I'm going to the gym");
  assert.ok(data.tool_events.some(event => event.tool === 'routine_use'));
  assert.ok(data.reply.endsWith(PLAY_TAP_LINE));
  assert.ok(data.presentation.some(card => card.type === 'music-offer' && card.query === 'workout'));
});

test('no offer when typing, when Spotify is not connected, or while defining a routine', async t => {
  const typed = await app(t, [[reply('Playing it now.')]], { spotify: { status: () => ({ connected: true, configured: true }), snapshot: async () => ({ connected: true }) } });
  const typedData = await typed.ask('play my workout playlist', 'typed');
  assert.ok(typed.calls[0].tools.includes('spotify_control'), 'typed requests keep the real Spotify tools');
  assert.equal(typedData.presentation.some(card => card.type === 'music-offer'), false);
  assert.equal(typedData.reply.includes(PLAY_TAP_LINE), false);

  const offline = await app(t, [[reply('Music controls are available by typing.')]], { spotify: guardedSpotify({ connected: false }) });
  const offlineData = await offline.ask('play my workout playlist');
  assert.equal(offlineData.presentation.some(card => card.type === 'music-offer'), false);
  assert.doesNotMatch(offline.calls[0].instructions, /big Play button/);

  const setup = await app(t, []);
  const saved = await setup.ask('When I say gym time, play my workout playlist.');
  assert.equal(saved.presentation.some(card => card.type === 'music-offer'), false);
  assert.equal(String(saved.reply).includes(PLAY_TAP_LINE), false);
});

test('the offer pulls down the big screen, keeps one device panel behind it, and MERLIN speaks beside it', () => {
  const o = new Orchestrator({ now: () => 0, render: () => {} });
  o.begin('gym');
  o.result('gym', {
    reply: `${'Leg day: squats, deadlifts, lunges and calf raises. '.repeat(6)}${PLAY_TAP_LINE}`,
    tool_events: [{ tool: 'routine_use', status: 'completed' }, { tool: 'home_control', status: 'completed' }, { tool: 'home_control', status: 'completed' }],
    presentation: [
      { type: 'lights', id: 'demo-home:gym-lights', label: 'Gym lights', status: 'on', simulated: true },
      { type: 'speaker', id: 'demo-home:gym-speaker', label: 'Gym speaker', status: 'on', simulated: true },
      { type: 'music-offer', id: 'spotify', query: 'workout', title: 'Workout', status: 'ready' },
    ],
  });
  assert.equal(o.bodyLayout, 'ceiling');
  assert.equal(o.panels.right.type, 'music-offer');
  assert.ok(['lights', 'speaker'].includes(o.panels.left?.type));
  o.reply('gym');
  assert.equal(o.speechDestination, 'ceiling', 'a long reply still speaks beside the Play screen');
  assert.equal(o.expandPanel('right'), false);
  assert.equal(o.dockPanel('left'), false);
  o.speaking(); o.followup(); o.standby();
  assert.equal(o.view.destination, 'ceiling');
  const kept = o.panels.left;
  o.dismiss('right');
  assert.equal(o.bodyLayout, 'right', 'the kept panel takes the big screen’s side instead of the ceiling-to-left move');
  assert.deepEqual(o.panels, { left: null, right: kept });
});

test('the Play button sits clear of MERLIN, and only a ready or failed offer can be tapped', () => {
  const width = 1600, height = 900;
  const [play] = playOfferTargets({ title: 'Workout', status: 'ready' }, width, height);
  assert.equal(play.action, 'play');
  assert.equal(play.label, 'Play Workout on Spotify');
  assert.ok(play.x >= ROBOT_ZONE.x1 * width, 'right of the robot');
  assert.ok(play.x + play.w <= width && play.y >= 0 && play.y + play.h <= height);
  assert.equal(playOfferTargets({ title: 'Workout', status: 'starting' }, width, height).length, 0);
  assert.equal(playOfferTargets({ title: 'Workout', status: 'playing' }, width, height).length, 0);
  assert.equal(playOfferTargets({ title: 'Workout', status: 'error', notice: 'Open Spotify first.' }, width, height).length, 1);
  assert.ok(playOfferLayout({ title: 'Workout', status: 'error', notice: 'Open Spotify first.' }, width, height).some(item => item.text === 'Open Spotify first.'));
  assert.equal(playOfferTargets({ title: 'Workout' }, 900, 1080).length, 1, 'portrait still has a button');
  assert.match(playOfferDescription({ title: 'Workout', status: 'ready' }), /Tap Play to start it/);
});

test('tapping Play prefers the person’s own playlist over public ones with the same name', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-own-playlist-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const OWN = 'spotify:playlist:OwnOwnOwnOwnOwnOwnOwn1', PUBLIC = 'spotify:playlist:PublicPublicPublic1234';
  const json = body => new Response(JSON.stringify(body), { status: 200 });
  const requests = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url); requests.push({ path: parsed.pathname, body: options.body });
    if (parsed.pathname === '/api/token') return json({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'user-read-playback-state user-modify-playback-state playlist-read-private' });
    if (parsed.pathname === '/v1/me/playlists') return json({ items: [{ name: 'Workout', uri: OWN }, { name: 'Sunday', uri: 'spotify:playlist:SundaySundaySunday1234' }] });
    if (parsed.pathname === '/v1/search') return json({ playlists: { items: [{ name: 'Workout', uri: PUBLIC }, { name: 'Workout', uri: 'spotify:playlist:AnotherAnotherAnother1' }] } });
    if (parsed.pathname === '/v1/me/player/devices') return json({ devices: [{ id: 'device1', name: 'Gym', type: 'Speaker', is_active: true, is_restricted: false, supports_volume: true }] });
    return new Response(null, { status: 204 });
  };
  const service = await new SpotifyService({ filePath: join(directory, 'spotify.json'), clientId: 'a'.repeat(32), fetchImpl }).init();
  const redirect = 'http://127.0.0.1:3210/api/spotify/callback';
  const { state } = service.beginAuthorization(redirect);
  await service.completeAuthorization({ code: 'synthetic-code', state, redirectUri: redirect });
  requests.length = 0;
  const result = await service.control({ action: 'play', query: 'workout', type: 'playlist' });
  assert.equal(result.status, 'accepted');
  const play = requests.find(request => request.path === '/v1/me/player/play');
  assert.deepEqual(JSON.parse(play.body), { context_uri: OWN });
  assert.equal(requests.some(request => request.path === '/v1/search'), false);
});
