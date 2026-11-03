import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { reply, saveFact, scriptedMeta, v2App } from './memory-v2-helpers.js';

const ALL = ['ack_01', 'ack_02', 'ack_03', 'ack_04', 'ack_05'];

// The owner found the clips silent for a whole conversation on November 3, 2026: an ordinary "today" or "don't"
// leaves a v2 conversation note, and every note used to silence them. Now only a note about speech does.
test('v2: ordinary conversation notes keep the clips; a note about how MERLIN talks silences them for that conversation', async t => {
  const meta = scriptedMeta([[reply('Okay.')], [reply('Okay.')], [reply('Okay.')], [reply('Okay.')], [reply('Okay.')]]);
  const { app } = await v2App(t, { meta });
  const session = randomUUID();
  const clipsFor = async (message, session_id = session) => {
    let received;
    await app.runChatTurn({ message, session_id, request_id: randomUUID(), time_zone: 'America/New_York' }, {
      onProgress: event => { if (event.stage === 'received') received = event.acknowledgments; },
    });
    return received?.clips;
  };
  assert.deepEqual(await clipsFor('Plan my week'), ALL);
  await clipsFor('Actually, turn on the gym speakers tonight instead.');
  assert.equal(app.memory.conversationNotes(session).filter(note => note.kind === 'statement').length, 1, 'that left a conversation note');
  assert.deepEqual(await clipsFor('Plan my week'), ALL, 'a note about speakers is not about speech');
  await clipsFor("Don't say that phrase anymore.");
  assert.deepEqual(await clipsFor('Plan my week'), [], 'a note about wording silences the rest of the conversation');
  assert.deepEqual(await clipsFor('Plan my week', randomUUID()), ALL, 'another conversation is unaffected');
});

test('v2: a fact saved in this conversation silences the clips only when it is about speech', async t => {
  const gym = 'Remember my workout routine turns on the gym speakers.';
  const brief = 'Remember I prefer brief answers.';
  const meta = scriptedMeta([
    [saveFact({ source_quote: gym, content: 'Workout routine turns on the gym speakers.' })], [reply('Got it.')], [reply('Okay.')],
    [saveFact({ source_quote: brief, content: 'Prefers brief answers.' })], [reply('Got it.')], [reply('Okay.')],
  ]);
  const { app } = await v2App(t, { meta });
  const session = randomUUID();
  const clipsFor = async message => {
    let received;
    await app.runChatTurn({ message, session_id: session, request_id: randomUUID(), time_zone: 'America/New_York' }, {
      onProgress: event => { if (event.stage === 'received') received = event.acknowledgments; },
    });
    return received?.clips;
  };
  await clipsFor(gym);
  assert.ok(app.memory.conversationNotes(session).some(note => note.kind === 'fact' && note.fact_kind === 'preference'));
  assert.deepEqual(await clipsFor('Plan my week'), ALL);
  await clipsFor(brief);
  assert.deepEqual(await clipsFor('Plan my week'), []);
});
