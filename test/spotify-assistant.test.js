import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Assistant } from '../src/assistant.js';
import { MemoryStore } from '../src/memory-store.js';
import { MemoryService } from '../src/memory.js';
import { normalizeRule } from '../src/memory-rules.js';
import { RoutinesStore, RoutineService } from '../src/routines.js';
import { TimerStore } from '../src/timers.js';
import { executeSpotifyTool, SPOTIFY_TOOL_NAMES, parseSimpleSpotifyControl } from '../src/spotify-tools.js';

const SECRET = 'synthetic-private-spotify-api-content-or-token';
const call = (name, args = {}, call_id = randomUUID()) => ({ type: 'function_call', status: 'completed', name, arguments: JSON.stringify(args), call_id });
const answer = text => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] });
const outputs = input => input.filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output));

function script(...steps) {
  return { calls: [], async respond(input, tools, instructions) {
    this.calls.push(structuredClone({ input, tools, instructions }));
    assert.ok(steps.length, 'Unexpected model call');
    const next = steps.shift();
    return typeof next === 'function' ? next(input, tools, instructions) : structuredClone(next);
  } };
}

function spotifyMock(overrides = {}) {
  const calls = [];
  const invoke = (name, args) => { calls.push({ name, args }); return { private_metadata: SECRET, access_token: SECRET }; };
  return {
    calls,
    status: () => ({ configured: true, connected: true, private_metadata: SECRET }),
    search: async args => invoke('search', args),
    playlists: async () => invoke('playlists'),
    snapshot: async () => invoke('snapshot'),
    control: async args => ({ ...invoke('control', args), ok: true, status: 'accepted', message: SECRET }),
    ...overrides,
  };
}

async function fixture(t, meta, spotify = spotifyMock()) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-spotify-assistant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new MemoryStore({ filePath: join(directory, 'memory.json') }).init();
  const routineStore = await new RoutinesStore({ filePath: join(directory, 'routines.json') }).init();
  const memory = new MemoryService(store);
  const routines = new RoutineService({ store: routineStore, memoryStore: store });
  const timers = await new TimerStore({ filePath: join(directory, 'timers.json') }).init();
  const assistant = new Assistant({ meta, timers, memory, routines, spotify });
  const traces = [];
  const session_id = randomUUID();
  const run = async message => {
    const request_id = randomUUID();
    const source = await store.recordMessage({ role: 'user', text: message, session_id, request_id });
    const result = await assistant.run({ message, session_id, request_id, source_id: source.id, time_zone: 'UTC', history: memory.history(session_id), onTrace: (...event) => traces.push(event) });
    await store.recordMessage({ role: 'assistant', text: result.reply, session_id, request_id, turn: result.turn, memory_ids: result.memory_ids ?? [] });
    return result;
  };
  const addRule = (kind, value, scope = 'tools') => store.putRule(normalizeRule({ kind, value, scope, original: 'Synthetic explicit instruction.', source_id: 'manual', source_quote: '', explanation: 'Synthetic test rule.' }), randomUUID());
  return { assistant, store, memory, routines, timers, spotify, traces, run, addRule, directory };
}

test('Spotify API metadata and credentials never enter Meta, protocol history, traces or retained memory', async t => {
  const meta = script(
    [call('spotify_search', { query: 'synthetic jazz', type: 'track' }), call('spotify_playlists'), call('spotify_status'), call('spotify_control', { action: 'play', query: 'synthetic jazz', type: 'track' })],
    input => {
      assert.equal(outputs(input).length, 4);
      assert.ok(outputs(input).every(item => item.ok));
      assert.doesNotMatch(JSON.stringify(input), new RegExp(SECRET));
      return [answer('Spotify is now playing your music.')];
    },
  );
  const app = await fixture(t, meta);
  const result = await app.run('Search Spotify for synthetic jazz, show playlists and player details, and play synthetic jazz.');
  assert.equal(app.spotify.calls.length, 4);
  assert.match(result.reply, /Request sent to Spotify/);
  assert.doesNotMatch(result.reply, /now playing/);
  const all = JSON.stringify([meta.calls, app.traces, result, app.store.snapshot(), app.memory.history('unused')]);
  assert.ok(!all.includes(SECRET));
  assert.ok(!(await readFile(join(app.directory, 'memory.json'), 'utf8')).includes(SECRET));
  const functionResults = outputs(result.turn);
  assert.equal(functionResults[3].result.status, 'accepted');
  assert.ok(!JSON.stringify(functionResults).includes('private_metadata'));
});

test('disconnection and arbitrary upstream errors use fixed helpful receipts without leaking provider text', async t => {
  for (const code of ['SPOTIFY_DEVICE', 'SPOTIFY_PREMIUM', 'SPOTIFY_RATE_LIMITED', 'UNKNOWN']) {
    const spotify = spotifyMock({ control: async () => { throw Object.assign(new Error(SECRET), { code }); } });
    const receipt = await executeSpotifyTool(spotify, 'spotify_control', { action: 'pause' });
    assert.equal(receipt.ok, false);
    assert.ok(!JSON.stringify(receipt).includes(SECRET));
  }
  const spotify = spotifyMock({ status: () => ({ configured: false, connected: false }) });
  const meta = script([call('spotify_control', { action: 'pause' })], [answer('Spotify is not implemented.')]);
  const app = await fixture(t, meta, spotify);
  const result = await app.run('Please pause the music currently playing in Spotify.');
  assert.equal(spotify.calls.length, 0);
  assert.equal(result.reply, 'Connect Spotify below first.');
  assert.equal(result.tool_events[0].status, 'failed');
});

test('an empty provider final after Spotify-only actions delivers checked receipts and replayable text', async t => {
  const meta = script([call('spotify_control', { action: 'volume', volume_percent: 27 }), call('spotify_playlists')], []);
  const app = await fixture(t, meta);
  await app.addRule('address_as', 'Captain', 'assistant_reply');
  const result = await app.run('Set Spotify volume to 27 percent and show my playlists.');
  assert.match(result.reply, /^Captain,/);
  assert.match(result.reply, /Request sent to Spotify/);
  assert.match(result.reply, /playlists are in the Spotify panel/);
  assert.equal(app.spotify.calls.length, 2);
  assert.equal(result.turn.at(-1).content[0].text, result.reply);
  assert.equal(result.turn.at(-1).role, 'assistant');
});

test('same-batch Spotify control restrictions are saved before the action and other tools remain independent', async t => {
  const instruction = 'Never control Spotify.';
  const meta = script([
    call('spotify_control', { action: 'play' }),
    call('memory_save_rule', { kind: 'tool_deny', value: 'spotify_control', scope: 'tools', source_quote: instruction, explanation: 'Block all Spotify playback controls.' }),
    call('create_timer', { label: 'Tea', duration: 30, unit: 'seconds' }),
  ], input => {
    const results = outputs(input);
    assert.equal(results[0].result.record.value, 'spotify_control');
    assert.equal(results[1].ok, false);
    assert.equal(results[2].result.duration_seconds, 30);
    return [answer('Your tea timer is set for 30 seconds. Spotify is playing.')];
  });
  const app = await fixture(t, meta);
  const result = await app.run(`${instruction} Resume Spotify and set a 30-second tea timer.`);
  assert.equal(app.spotify.calls.length, 0);
  assert.match(result.reply, /tea timer is set for 30 seconds/);
  assert.match(result.reply, /settings do not allow/);
  assert.doesNotMatch(result.reply, /Spotify is playing/);
});

test('routine authoring and lookup with hallucinated Spotify calls cannot query or control Spotify', async t => {
  const meta = script(
    (_input, tools) => { assert.ok(tools.every(tool => !SPOTIFY_TOOL_NAMES.includes(tool.name))); return SPOTIFY_TOOL_NAMES.map(name => call(name, name === 'spotify_search' ? { query: 'synthetic jazz', type: 'track' } : name === 'spotify_control' ? { action: 'play' } : {})); },
    [answer('What should I call it?')],
    (_input, tools) => { assert.ok(tools.every(tool => !SPOTIFY_TOOL_NAMES.includes(tool.name))); return [call('spotify_control', { action: 'play' })]; },
    [answer('It requests music when you start it.')],
  );
  const app = await fixture(t, meta);
  await app.run('Create a routine named Tea with Spotify music.');
  await app.routines.store.save({ name: 'Tea', aliases: [], prompt: 'Play synthetic jazz on Spotify.', source_id: 'manual', source_quote: '' });
  await app.run('Show me my Tea routine.');
  assert.equal(app.spotify.calls.length, 0);
});

test('a search ban cannot be bypassed by asking playback to resolve a music query', async t => {
  const meta = script([call('spotify_control', { action: 'play', query: 'Synthetic song', type: 'track' })], [answer('Spotify is playing.')]);
  const app = await fixture(t, meta);
  await app.addRule('tool_deny', 'spotify_search');
  const result = await app.run('Play Synthetic song on Spotify.');
  assert.equal(app.spotify.calls.length, 0);
  assert.equal(result.tool_events[0].status, 'failed');
  assert.ok(app.traces.some(([stage, , data]) => stage === 'tool_check' && data.violations?.some(item => item.code === 'TOOL_DENIED')));
});

test('Spotify rule and argument failures use conversational receipts while retaining technical protocol evidence', async t => {
  for (const scenario of [
    { proposal: call('spotify_control', { action: 'play', query: 'Synthetic song' }), blocked: true, technical: /standing instruction blocks/, conversational: /settings do not allow/ },
    { proposal: { ...call('spotify_control'), arguments: '{invalid' }, technical: /valid JSON/, conversational: /couldn't complete that Spotify request/ },
    { proposal: call('spotify_control', { action: 'play', unknown_field: true }), technical: /Unexpected fields/, conversational: /couldn't complete that Spotify request/ },
  ]) {
    const meta = script([scenario.proposal], [answer('Done.')]);
    const app = await fixture(t, meta);
    if (scenario.blocked) await app.addRule('tool_deny', 'spotify_control');
    const result = await app.run('Play Synthetic song on Spotify.');
    assert.equal(app.spotify.calls.length, 0);
    assert.match(result.reply, scenario.conversational);
    assert.doesNotMatch(result.reply, /spotify_control|JSON|arguments|schema|Unexpected fields|standing instruction blocks/);
    assert.match(outputs(result.turn).at(-1).error, scenario.technical);
    assert.match(result.tool_events.at(-1).message, scenario.technical);
  }
});

test('blocked Spotify proposals do not add action-failure receipts to successful routine saves or lookups', async t => {
  const prompt = 'play synthetic jazz on Spotify.';
  const message = `Create a routine named Tea with these steps: ${prompt}`;
  const meta = script([
    call('spotify_control', { action: 'play', query: 'synthetic jazz' }),
    call('routine_save', { id: '', name: 'Tea', aliases: [], prompt, source_quote: message }),
  ], [answer('Saved.')], [call('spotify_status'), call('spotify_control', { action: 'play' })], [answer('Your routine requests synthetic jazz.')]);
  const app = await fixture(t, meta);
  const saved = await app.run(message);
  assert.equal(saved.reply, 'Saved.');
  assert.equal(app.routines.store.list().length, 1);
  const lookup = await app.run('Show me my Tea routine.');
  assert.equal(lookup.reply, 'Your routine requests synthetic jazz.');
  assert.equal(app.spotify.calls.length, 0);
  for (const result of [saved, lookup]) {
    assert.ok(result.tool_events.some(event => event.tool.startsWith('spotify_') && event.status === 'failed'));
    assert.ok(outputs(result.turn).some(item => /routine setup or inspection/.test(item.error ?? '')));
  }
});

test('an activated routine may request Spotify but exact identifiers must be supplied by its user-authored prompt', async t => {
  const uri = 'spotify:track:1234567890123456789012';
  const prompt = `Play ${uri} on Kitchen.`;
  const meta = script([call('spotify_control', { action: 'play', uri, device_name: 'Kitchen' })], [answer('Spotify is playing.')]);
  const app = await fixture(t, meta);
  await app.routines.store.save({ name: 'Tea', aliases: [], prompt, source_id: 'manual', source_quote: '' });
  const result = await app.run('Tea');
  assert.equal(app.spotify.calls.length, 1);
  assert.equal(app.spotify.calls[0].args.uri, uri);
  assert.match(result.reply, /Request sent/);
  await assert.rejects(executeSpotifyTool(app.spotify, 'spotify_control', { action: 'play', uri }, { message: 'Play some jazz.' }), /from your request/);
  await assert.rejects(executeSpotifyTool(app.spotify, 'spotify_control', { action: 'play', device_name: 'Invented Room' }, { message: 'Resume.' }), /Name the playback device/);
  await assert.rejects(executeSpotifyTool(app.spotify, 'spotify_control', { action: 'play', device_id: SECRET }, { message: 'Resume.' }), /Unexpected fields/);
});

test('compound search answers survive the Spotify receipt guard and final output instructions still apply', async t => {
  const meta = script([call('spotify_control', { action: 'pause' }), call('prepare_web_search')],
    [ { type: 'web_search_call', id: 'synthetic-search', status: 'completed' }, answer('The museum opens at 10 a.m. Your Spotify music is paused.') ]);
  const app = await fixture(t, meta);
  await app.addRule('address_as', 'Captain', 'assistant_reply');
  const result = await app.run('Pause Spotify and search for the museum opening time.');
  assert.match(result.reply, /^Captain,/);
  assert.match(result.reply, /museum opens at 10 a\.m\./);
  assert.match(result.reply, /Request sent to Spotify/);
  assert.doesNotMatch(result.reply, /music is paused/);
  assert.ok(result.tool_events.some(event => event.tool === 'web_search' && event.status === 'completed'));
});

test('a required output ban still blocks fixed Spotify receipts without executing actions twice', async t => {
  const meta = script([call('spotify_control', { action: 'pause' })], [answer('Done.')], [answer('Sent.')]);
  const app = await fixture(t, meta);
  await app.addRule('avoid_word', 'Spotify', 'assistant_reply');
  const result = await app.run('Please pause the music currently playing in Spotify.');
  assert.equal(app.spotify.calls.length, 1);
  assert.doesNotMatch(result.reply, /spotify/iu);
  assert.ok(meta.calls.at(-1).tools.length === 0);
});

test('simple explicit Spotify controls are fast and retain rules, output validation and privacy checks', async t => {
  const meta = script();
  const app = await fixture(t, meta);
  await app.addRule('address_as', 'Captain', 'assistant_reply');
  for (const [message, action] of [['Pause Spotify.', 'pause'], ['Merlin, resume Spotify please.', 'play'], ['Next song on Spotify.', 'next'], ['Previous track on Spotify.', 'previous']]) {
    const result = await app.run(message);
    assert.equal(app.spotify.calls.at(-1).args.action, action);
    assert.match(result.reply, /^Captain, Request sent to Spotify/);
    assert.equal(meta.calls.length, 0);
  }
  const count = app.spotify.calls.length;
  await app.addRule('tool_deny', 'spotify_control');
  const denied = await app.run('Pause Spotify.');
  assert.equal(app.spotify.calls.length, count);
  assert.match(denied.reply, /settings do not allow/);
  await app.addRule('avoid_word', 'Spotify', 'assistant_reply');
  const checked = await app.run('Resume Spotify.');
  assert.doesNotMatch(checked.reply, /spotify/iu);
  assert.equal(meta.calls.length, 0);
  assert.ok(!JSON.stringify([app.traces, app.store.snapshot()]).includes(SECRET));
});

test('simple music matching rejects definitions, questions, quoted examples and compound work; relevant guidance uses Meta', async t => {
  for (const message of ['"Pause Spotify."', 'Do not pause Spotify.', 'Can I pause Spotify?', 'Pause Spotify and set a timer.', 'If I say quiet, pause Spotify.', 'How do I resume Spotify?', 'Pause the video.']) assert.equal(parseSimpleSpotifyControl(message), null, message);
  const meta = script([call('spotify_control', { action: 'pause' })], [answer('Done.')]);
  const app = await fixture(t, meta);
  await app.store.putFact({ content: 'Keep music quiet when the baby is asleep.', subject: 'household', kind: 'guidance', source_id: 'manual', source_quote: '', reason: 'Requires contextual interpretation.' }, 'synthetic-guidance');
  const result = await app.run('Pause Spotify.');
  assert.equal(meta.calls.length, 2);
  assert.match(meta.calls[0].instructions, /Keep music quiet/);
  assert.match(result.reply, /Request sent/);
});
