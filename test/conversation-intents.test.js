import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant } from '../src/assistant.js';
import { isPureAcknowledgment } from '../src/conversation-intents.js';
import { MemoryStore } from '../src/memory-store.js';
import { MemoryService } from '../src/memory.js';
import { RoutinesStore, RoutineService } from '../src/routines.js';
import { TimerStore } from '../src/timers.js';

const answer = text => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] });
const call = (name, args) => ({ type: 'function_call', status: 'completed', name, arguments: JSON.stringify(args), call_id: randomUUID() });

async function fixture(t, steps, { withMemory = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-acknowledgment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = withMemory ? await new MemoryStore({ filePath: join(directory, 'memory.json') }).init() : undefined;
  const memory = store ? new MemoryService(store) : undefined;
  const routines = store ? new RoutineService({
    store: await new RoutinesStore({ filePath: join(directory, 'routines.json') }).init(), memoryStore: store,
  }) : undefined;
  const timers = await new TimerStore({ filePath: join(directory, 'timers.json') }).init();
  const spotifyCalls = [];
  const spotify = { status: () => ({ connected: true }), async control(args) {
    spotifyCalls.push(args); return { ok: true, status: 'accepted' };
  } };
  const meta = { calls: [], async respond(input, tools, instructions) {
    this.calls.push({ input: structuredClone(input), tools, instructions });
    assert.ok(steps.length, 'Unexpected model call');
    const step = steps.shift();
    return typeof step === 'function' ? step(input, tools, instructions) : step;
  } };
  const assistant = new Assistant({ meta, timers, memory, routines, spotify });
  const session_id = randomUUID();
  const history = [];
  const run = async message => {
    const request_id = randomUUID();
    const source = await store?.recordMessage({ role: 'user', text: message, session_id, request_id });
    const result = await assistant.run({ message, session_id, request_id, source_id: source?.id, time_zone: 'UTC',
      history: memory ? memory.history(session_id) : history });
    if (store) await store.recordMessage({ role: 'assistant', text: result.reply, session_id, request_id, turn: result.turn, memory_ids: result.memory_ids ?? [] });
    else history.push(...result.turn);
    return result;
  };
  return { run, meta, spotifyCalls, timers, routines };
}

test('only complete appreciation is classified, leaving commands, confirmations and routine wording alone', () => {
  for (const message of ['Thank you!', 'Thanks.', 'Thanks so much!', 'Thank you very much.', 'Okay, thanks!', 'Great, thank you.', 'Merlin, thank you!', 'Thanks, Merlin.', 'I really appreciate it.', 'Appreciate your help.', 'Cheers!']) {
    assert.equal(isPureAcknowledgment(message), true, message);
  }
  for (const message of ['Thanks, pause Spotify.', 'Thank you! Set another timer.', 'Thanks and resume Spotify', 'Okay', 'Yes', 'Do it', 'Thanks?', '"Thank you"', 'What does thanks mean?', 'If I say thanks, pause Spotify.', 'Start my thanks routine', 'Thanks\nPause Spotify', null]) {
    assert.equal(isPureAcknowledgment(message), false, message);
  }
});

test('thanks after a local Spotify action gets a useful tool-free response without replaying the action', async t => {
  const app = await fixture(t, [(input, tools, instructions) => {
    assert.deepEqual(tools, []);
    assert.match(instructions, /current message is only appreciation/);
    assert.match(JSON.stringify(input), /Pause Spotify/);
    return [answer('A pleasure! Little jobs are my specialty.')];
  }]);
  await app.run('Pause Spotify.');
  assert.equal(app.meta.calls.length, 0); assert.equal(app.spotifyCalls.length, 1);
  const thanks = await app.run('Thank you!');
  assert.equal(thanks.reply, 'A pleasure! Little jobs are my specialty.');
  assert.deepEqual(thanks.tool_events, []); assert.equal(app.spotifyCalls.length, 1);
  assert.doesNotMatch(thanks.reply, /Request sent|Spotify/);
});

test('a rogue acknowledgment tool call is rejected before execution with and without memory', async t => {
  for (const withMemory of [true, false]) {
    const app = await fixture(t, [(_input, tools) => {
      assert.deepEqual(tools, []);
      return [call('spotify_control', { action: 'pause' }), call('create_timer', { label: 'Unrequested', duration_seconds: 30 })];
    }], { withMemory });
    await app.run('Pause Spotify.');
    await assert.rejects(app.run('Thank you!'), /tool that was not enabled/);
    assert.equal(app.spotifyCalls.length, 1); assert.equal((await app.timers.list()).length, 0);
  }
});

test('thanks followed by an explicit command retains its requested tool execution', async t => {
  const app = await fixture(t, [(_input, tools) => {
    assert.ok(tools.some(tool => tool.name === 'spotify_control'));
    return [call('spotify_control', { action: 'play' })];
  }, [answer('')]]);
  const result = await app.run('Thanks, resume Spotify.');
  assert.deepEqual(app.spotifyCalls, [{ action: 'play' }]);
  assert.match(result.reply, /Request sent to Spotify/);
});

test('an exact user-defined thanks routine activates before the appreciation guard', async t => {
  const app = await fixture(t, [(_input, tools) => {
    assert.ok(tools.some(tool => tool.name === 'spotify_control'));
    return [call('spotify_control', { action: 'pause' })];
  }, [answer('Your saved request was followed.')]]);
  await app.routines.store.save({ name: 'Thanks', aliases: [], prompt: 'Pause Spotify.', source_id: 'manual', source_quote: '' });
  const result = await app.run('Thanks!');
  assert.deepEqual(app.spotifyCalls, [{ action: 'pause' }]);
  assert.ok(result.tool_events.some(event => event.tool === 'routine_use' && event.status === 'completed'));
});
