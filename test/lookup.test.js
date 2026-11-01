import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyLookup, LookupTracker, stripCitationMarkers, lookupDirective } from '../src/lookup.js';

const level = message => classifyLookup(message).level;

test('an explicit request to look something up is always classified as explicit', () => {
  for (const message of [
    'look it up', 'Look that up for me', 'all look it up online', 'Please look up the Mets score',
    'what movies are playing tonight at AMC Monmouth Mall, look it up', 'whens the enxt nyx marathon, look it up',
    'search the web and let me know weather tomorrow in brooklyn NY', 'Search for how to descale a kettle',
    'Set a 3 minute tea timer and search for steeping tips', 'google the nearest pharmacy', 'Can you google that?',
    'check online if the library is open', 'Can you look up the weather in Boston?', "don't forget to look it up",
    'Pause Spotify and search for the museum opening time.', 'find the answer on the web', 'LOOK IT UP!!',
  ]) assert.equal(level(message), 'explicit', message);
});

test('time-sensitive and factual questions require a source', () => {
  for (const message of [
    "what's the weather today?", 'whats tom weather in brooklyn NY', 'any news on the election', 'what is the price of bitcoin?',
    'who won the last world series?', 'what time does the pharmacy close', 'tell me the weather', 'Is it going to rain? what is the forecast',
    'whats the biggest state?', 'how tall is mount everest?', "what's the capital of Australia?", 'how long should I steep green tea?',
    'how do I descale a kettle?', 'Can you tell me who invented the telephone?', 'do you know when the Berlin wall fell', 'why is the sky blue',
    'which planet has the most moons', 'is there a pharmacy near me open late', 'whos winning the game tonight', 'whats playing at the movies tonight', 'weather in brooklyn', 'I want to know the weather in Boston',
    'What color is the sky?', 'what is photosynthesis', 'what should I eat before I workout', 'what do I do when the smoke alarm beeps',
  ]) assert.equal(level(message), 'required', message);
});

test('household, device, conversation, and calculation requests are never lookups', () => {
  for (const message of [
    'hello there', "what's your name?", 'what can you do', 'who are you', 'how are you doing today', 'thanks!', 'why?', 'what do you mean',
    'set a 30 second tea timer', 'what timers are running right now?', 'cancel the pasta timer', 'how long should I set the timer for',
    'play some jazz', 'search Spotify for Adele', 'search for songs by Adele', 'search my notes for the wifi password', 'look up my gym routine',
    "what's my default timer", 'what did I tell you about coffee', 'Which milk do I prefer?', "what's my favorite color", 'what do I usually drink in the morning', 'remember that I like oat milk', 'turn off the lights', 'show me the living room camera',
    "what's the date today?", 'whats the date today', 'whats the time', 'what time is it', 'what day is it', "what's 15 plus 27", 'what is 20% of 80', 'tell me a joke',
    // Conversation follow-ups, statements, and requests to process supplied text.
    'What is next?', 'who is she', "what's that", 'Read this synthetic weather sample.', 'Merlin, read the synthetic weather sample.',
    'I love this weather', "it's raining again", 'this storm is wild', 'Thanks, looking that up was great!',
    '', '   ',
  ]) assert.equal(level(message), 'none', JSON.stringify(message));
});

test('declined, hypothetical, capability, and routine-definition mentions do not trigger a lookup', () => {
  for (const message of [
    "don't look it up", 'no need to search the web', 'Never search the web.', 'please stop searching', 'do not google that', 'without searching, what do you think',
    'can you search the web?', 'can you look things up?', 'do you search the internet', 'are you able to browse', // ability questions
    'whenever I say gym, look up my workout plan', 'if I say coffee, tell me the weather and set a timer',
  ]) assert.equal(level(message), 'none', message);
  // Capability wording that carries an actual request stays a request.
  assert.equal(level('can you search the web for tea brewing tips'), 'explicit');
  // A stop command for something else must not swallow the search that follows it.
  assert.equal(level('stop the timer and look up the weather'), 'explicit');
});

test('classification gives a fixed reason and never echoes the user text', () => {
  const secret = 'my account 1234-SECRET';
  const decision = classifyLookup(`look up ${secret}`);
  assert.equal(decision.level, 'explicit');
  assert.ok(!decision.reason.includes('SECRET'));
  assert.equal(classifyLookup('hello').reason, '');
});

test('tracker records only completed searches, safe result links, and bounded queries', () => {
  const tracker = new LookupTracker();
  tracker.setPolicy({ level: 'explicit', reason: 'x' });
  assert.equal(tracker.state(), 'failed');
  tracker.record({ type: 'web_search_call', status: 'failed', action: { query: 'ignored' } });
  assert.equal(tracker.satisfied, false);
  assert.equal(tracker.state(), 'failed');
  tracker.record({ type: 'web_search_call', status: 'completed', action: { type: 'search', query: ' weather new york ' }, results: [
    { type: 'text_result', title: 'NWS', url: 'https://forecast.weather.gov/x', snippet: 'private snippet' },
    { type: 'text_result', title: 'Bad', url: 'javascript:alert(1)' }, { title: 'Missing' }, { url: 'not a url' },
    { title: 'Duplicate', url: 'https://forecast.weather.gov/x' },
  ] });
  assert.equal(tracker.satisfied, true);
  assert.equal(tracker.state(), 'done');
  assert.deepEqual(tracker.queries, ['weather new york']);
  assert.deepEqual(tracker.retrievedSources(), [{ url: 'https://forecast.weather.gov/x', title: 'NWS', basis: 'retrieved' }]);
  const summary = tracker.summary();
  assert.deepEqual([summary.searches, summary.failed_searches, summary.state], [1, 1, 'done']);
  assert.ok(!JSON.stringify(summary).includes('private snippet'));
  tracker.enforced = 1;
  assert.equal(tracker.state(), 'enforced');
});

test('tracker states for required, blocked, and unrequired lookups', () => {
  const tracker = new LookupTracker();
  assert.equal(tracker.summary(), null);
  assert.equal(tracker.state(), 'not_required');
  tracker.setPolicy({ level: 'required', reason: 'x' });
  assert.equal(tracker.state(), 'unverified');
  tracker.blocked = 'denied';
  assert.equal(tracker.state(), 'blocked');
  tracker.setPolicy({ level: 'none', reason: '' });
  assert.equal(tracker.blocked, '');
  tracker.record({ type: 'web_search_call', status: 'completed' });
  assert.equal(tracker.state(), 'searched');
  assert.equal(tracker.summary().policy, 'none');
});

test('citation markers are removed without touching the sentence', () => {
  assert.equal(stripCitationMarkers('Rain is likely tomorrow.【1743273222577323410†L8-L10】 Bring an umbrella.'), 'Rain is likely tomorrow. Bring an umbrella.');
  assert.equal(stripCitationMarkers('Sunny 【4†L1-L2】, high of 60.'), 'Sunny, high of 60.');
  assert.equal(stripCitationMarkers('No markers [1] here.'), 'No markers [1] here.');
  assert.equal(stripCitationMarkers(undefined), undefined);
});

test('model directives distinguish mandatory, satisfied, blocked, and enforced lookups', () => {
  const tracker = new LookupTracker();
  assert.equal(lookupDirective(tracker), '');
  tracker.setPolicy({ level: 'explicit', reason: 'You asked me to look this up.' });
  assert.match(lookupDirective(tracker), /mandatory/);
  assert.match(lookupDirective(tracker, { enforcing: true }), /discarded/);
  tracker.record({ type: 'web_search_call', status: 'completed' });
  assert.match(lookupDirective(tracker), /has completed/);
  const blocked = new LookupTracker();
  blocked.setPolicy({ level: 'required', reason: 'r' });
  blocked.blocked = 'denied';
  assert.match(lookupDirective(blocked), /blocks web search/);
});
