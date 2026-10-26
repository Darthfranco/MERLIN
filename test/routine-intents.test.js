import assert from 'node:assert/strict';
import test from 'node:test';
import { detectRoutineIntent, isRoutineDefinitionBlocked } from '../src/routine-intents.js';

const user = text => ({ role: 'user', text });
const assistant = text => ({ role: 'assistant', text });
const detect = (message, messages = [], routines = []) => detectRoutineIntent({ message, messages, routines });

test('complete definition requests classify generic routine names without activating the recipe', () => {
  for (const [message, name] of [
    ['Save a routine named tea break with alias brew time: Start a three-minute tea timer.', 'tea break'],
    ['Set Tea as a routine then.', 'Tea'],
    ['Create a routine called "Morning focus": Set a 15 minute timer.', 'Morning focus'],
    ['Please save my Evening routine: Look up the weather.', 'Evening'],
    ['Can you save this as a routine named "Studio time"?', 'Studio time'],
    ['Routine named Recovery: Start a 30 second timer.', 'Recovery'],
    ['Bedtime should make a timer for 5 minutes and look up 3 stocks.', 'Bedtime'],
    ['Bedtime shoudl make a timer for 5 minutes.', 'Bedtime'],
    ['ok goodnight should make a timer for 5 minutes and look up 3 stocks ALSO goodnight', 'goodnight'],
    ['When I say "lights out", start a 5 minute timer.', 'lights out'],
    ['When I say focus start a 10 minute timer.', 'focus'],
  ]) {
    const result = detect(message);
    assert.equal(result?.mode, 'authoring', message);
    assert.equal(result.name, name, message);
    assert.equal(result.run_now, false, message);
  }
});

test('running during authoring requires a separate explicit current execution clause', () => {
  for (const message of [
    'Save a routine named Tea: Start a 3 minute timer, also run it now.',
    'Set Tea as a routine and start it now.',
    'Bedtime should set a timer for five minutes; run this routine now.',
  ]) assert.equal(detect(message)?.run_now, true, message);
  for (const message of [
    'Tea should start a 3 minute timer now.',
    'Tea should set a 3 minute timer and start it now.',
    'Tea should say "also run it now".',
    "Save a routine named Tea: Say 'start it now'.",
    'Tea should make a timer. Also Tea.',
    'Set Tea as a routine, do not run it now.',
  ]) assert.notEqual(detect(message)?.run_now, true, message);
});

test('references and quoted bodies can continue recent authoring without duplicating its name', () => {
  const messages = [user('Bedtime should start a 5 minute timer.'), assistant('Should I save that as a routine?')];
  for (const message of ['What we already said.', 'Use what I just said.', '"Start a 5 minute timer."', 'yes', 'yes please', 'save it']) {
    const result = detect(message, messages);
    assert.equal(result?.mode, 'authoring', message);
    assert.equal(result.name, 'Bedtime', message);
    assert.equal(result.run_now, false, message);
  }
  assert.equal(detect('Set it as a routine then.', messages).name, 'Bedtime');
  assert.equal(detect('What we already said.', [...messages, user('Set Bedtime as a routine then.'), assistant('What should it do?')]).name, 'Bedtime');
  assert.equal(detect('What we already said.', [...messages, user('What we already said.')]).name, 'Bedtime', 'A trailing current record is tolerated');
});

test('unrelated turns and activation questions cannot turn a later yes or quote into authoring', () => {
  const authoring = [user('Bedtime should start a timer.'), assistant('Should I save it as a routine?')];
  for (const message of ['yes', 'What we already said.', '"Start a timer."']) {
    assert.equal(detect(message), null);
    assert.equal(detect(message, [...authoring, user('Tell me the weather.'), assistant('It is sunny.')]), null);
  }
  assert.equal(detect('yes', [user('Bedtime should start a timer.'), assistant('Do you want me to run the routine now?')]), null);
  assert.equal(detect('yes', [user('Hello.'), assistant('Should I save Tea as a routine?')]), null, 'Assistant words alone do not establish user creation intent');
  assert.equal(detect('What we already said.', [...authoring, ...Array.from({ length: 11 }, () => assistant('A bounded history entry.'))]), null);
});

test('a persisted save receipt closes setup even when the assistant asks a redundant confirmation', () => {
  const completed = [{ ...user('Tea should set a 20-second timer.'), routine_saved: true }, assistant('Should I save those steps as a routine?')];
  for (const message of ['yes', '"set a 30-second timer."', 'what we already said', 'save it', 'use that']) {
    assert.equal(detect(message, completed), null, message);
    assert.equal(isRoutineDefinitionBlocked(message), true, message);
  }
  const unfinished = [user('Tea should set a 20-second timer.'), assistant('Should I save those steps as a routine?')];
  const confirmed = detect('yes', unfinished);
  assert.equal(confirmed.mode, 'authoring');
  assert.equal(isRoutineDefinitionBlocked('yes', { allowContinuation: confirmed.mode === 'authoring' }), false);
  assert.equal(detect('Set Tea as a routine then.', completed).mode, 'authoring', 'A new explicit save request may authorize an edit');
});

test('negations, examples, third-person reports, ordinary commands and semantic near-matches remain unclassified', () => {
  for (const message of [
    'Do not save Tea as a routine.', 'Never create a routine named Tea.',
    'For example, Tea should start a timer.', 'Suppose Tea should start a timer.',
    'If I say Tea, start a timer.', 'What if Bedtime should start a timer?',
    'He said Tea should start a timer.', 'Alice asked to save Tea as a routine.',
    'My friend should start a timer.', 'I should start a timer.', 'We should look up weather.',
    'Someone should set a timer.', 'She really should set a timer.', 'They should look up the weather.',
    '"Save Tea as a routine."', 'Set a timer for five minutes.', 'start Tea',
    '"Tea should set a 20-second tea timer."',
    'What should I eat before a workout?', 'How can I get a goodnight of sleep?',
    'Is “Tea should set a 20-second tea timer.” an example of a routine definition?',
    'Does Tea should start a timer make sense?', 'What should I set as my routine?',
    "I'm going to exercise in the gym", 'Tea should be relaxing.',
  ]) assert.equal(detect(message), null, message);
});

test('lookup requests identify exact existing names and aliases without granting activation', () => {
  const routines = [{ name: 'Tea', aliases: ['brew time'] }, { name: 'Night reset', aliases: [] }];
  for (const message of ["What's my Tea routine?", 'What does my Tea routine do?', 'Look up Tea', 'Show me the brew time routine.', 'Show me my saved Tea routine.', 'What are the steps of my Tea routine?', 'ok so what is my Tea routine?', 'Describe Tea.']) {
    const result = detect(message, [], routines);
    assert.equal(result?.mode, 'lookup', message);
    assert.equal(result.name, 'Tea', message);
    assert.equal(result.run_now, false, message);
  }
  for (const message of ['Look up Tea prices', 'Look up stock prices', 'What is my unknown routine?', 'Tea', 'run Tea']) assert.equal(detect(message, [], routines), null, message);
});

test('definition blocking rejects non-authorizing prose and requires genuine authoring context for quotations and references', () => {
  for (const message of [
    'Do not save Tea as a routine.', 'For example, Tea should start a timer.',
    'If I said save Tea as a routine, what would happen?',
    'A friend said save Tea as a routine.', 'Alice asked to save Tea as a routine.',
    'What does my Tea routine do?', 'How do I create a routine?',
    'Is “Tea should set a 20-second tea timer.” an example of a routine definition?',
    'Does Tea should start a timer make sense?', 'What should I set as my routine?',
    'Someone should set a timer.', 'She really should set a timer.',
    'Can you explain how to save a routine?', 'Tell me about Tea.', 'Look up Tea.',
  ]) assert.equal(isRoutineDefinitionBlocked(message), true, message);
  for (const message of [
    'Can you save Tea as a routine?', 'Could you create a routine named Tea: Start a timer?',
    'When I say Tea, start a timer.',
  ]) assert.equal(isRoutineDefinitionBlocked(message), false, message);
  for (const message of ['What we already said.', '"Start a timer, then look up the weather."', '"Tea should set a 20-second timer."', 'yes', 'yes please', 'save it', 'use that']) {
    assert.equal(isRoutineDefinitionBlocked(message), true, message);
    assert.equal(isRoutineDefinitionBlocked(message, { allowContinuation: true }), false, message);
  }
});
