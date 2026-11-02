import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyLookup, userStatements, LookupTracker, stripCitationMarkers, lookupDirective } from '../src/lookup.js';

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
    "what's my default timer", 'what did I tell you about coffee', 'remember that I like oat milk', 'turn off the lights', 'show me the living room camera',
    "what's the date today?", 'whats the date today', 'whats the time', 'what time is it', 'what day is it', "what's 15 plus 27", 'what is 20% of 80', 'tell me a joke',
    // Conversation follow-ups, statements, and requests to process supplied text.
    'What is next?', 'who is she', "what's that", 'Read this synthetic weather sample.', 'Merlin, read the synthetic weather sample.',
    'I love this weather', "it's raining again", 'this storm is wild', 'Thanks, looking that up was great!',
    '', '   ',
  ]) assert.equal(level(message), 'none', JSON.stringify(message));
});

test('questions about the household\'s own people, pets and things are answered at home', () => {
  for (const message of [
    'where does my dog nap?', 'how old is our cat', 'which vet does my dog see', 'what kind of food does my cat eat', 'do you know where my dog naps',
    'where do we keep the batteries?', 'where did I put the scissors', 'where does the dog nap', "where's the spare key", "what's the wifi password", 'how old is the cat',
    'what does mom like', "where's dad", 'Which milk do I prefer?', "what's my favorite color", 'what do I usually drink in the morning',
  ]) assert.equal(level(message), 'household', message);
});

test('an unfamiliar name may be one of theirs, so nothing is forced and web results get labeled', () => {
  for (const message of [
    'Where does Biscuit nap?', 'where does biscuit nap', 'How old is Biscuit?', "Where's Biscuit?", "What's Biscuit's favorite toy?", 'Does Biscuit like walks?',
    'Is Biscuit allergic to chicken?', 'Where does Aunt Mae live?', 'do you know where Biscuit naps', 'what is biscuit allergic to',
  ]) {
    const decision = classifyLookup(message);
    assert.equal(decision.level, 'unknown_subject', message);
    assert.equal(decision.general_only, true, message);
  }
});

test('general questions that merely mention the household or read like a name still need a source', () => {
  for (const message of [
    'why does my dog eat grass', 'how much should my dog weigh', 'what can the dog eat', 'what happens if the dog eats chocolate', 'what should I feed my cat',
    'how do I clean my kettle', 'where do I buy a kettle', 'what is the best food for my dog', "what's the weather at my house?",
    'Where does Taylor Swift live?', 'How tall is Mount Everest?', 'how tall is mount everest', 'what is photosynthesis', 'what does nasa stand for', 'what does ephemeral mean',
    'where did dinosaurs live', 'When does Costco open?', 'who invented the telephone', 'Who is Einstein?', 'who was einstein',
  ]) assert.equal(level(message), 'required', message);
  // A link means the question is about that page.
  assert.equal(level('where does Biscuit nap according to https://example.org/pets'), 'required');
  // Conversation that only looks like a question stays conversation.
  for (const message of ['Was great!', 'Is dinner ready?', 'Is everything ok?', 'who is she']) assert.equal(level(message), 'none', message);
});

test('saved memory and earlier statements decide whether a name belongs to the household', () => {
  const asked = (message, ...evidence) => classifyLookup(message, { evidence }).level;
  for (const evidence of ['Biscuit naps on the sunporch.', 'Just so you know, my dog Biscuit naps on the sunporch.', 'Biscuit: likes the blue couch', 'We have a dog named Biscuit.', "Biscuit's bed is upstairs.", 'The dog Biscuit snores.']) {
    assert.equal(asked('Where does Biscuit nap?', evidence), 'household', evidence);
    assert.equal(asked('where does biscuit nap', evidence), 'household', evidence);
  }
  assert.equal(asked('Where does Biscuit nap?', 'Our dog Rex sleeps on the couch.'), 'unknown_subject', 'memory about someone else does not count');
  assert.equal(asked('Who is Biscuit?', 'Biscuit naps on the sunporch.'), 'household');
  assert.equal(asked('Who feeds Biscuit?', 'Biscuit naps on the sunporch.'), 'household');
  assert.equal(asked("what's biscuit's vet called?", 'Biscuit naps on the sunporch.'), 'household');
  assert.equal(asked('What time does Biscuit eat?', 'Biscuit naps on the sunporch.'), 'household');

  // The answer is already there, even though nothing in the wording says "ours".
  assert.equal(asked("what's the garage code?", 'The garage code is one two three.'), 'household');
  assert.equal(asked("who's the plumber?", 'Our plumber is Sam.'), 'household');
  assert.equal(asked('how long should I steep green tea?', 'We steep green tea for four minutes.'), 'household');
  assert.equal(asked("what's the garage code?"), 'required');

  // A mention in memory never turns a real web question into a household one.
  assert.equal(asked("what's the capital of Australia?", 'We visited Australia last year.'), 'required');
  assert.equal(asked("What's the weather in Springfield?", 'Our town is Springfield.'), 'required');
  assert.equal(asked('what time does the Costco close', 'We shop at Costco.'), 'required');
  assert.equal(asked('Who won the Mets game?', 'Our team is the Mets.'), 'required');
  assert.equal(asked('how tall is mount everest', 'We climbed near Mount Everest.'), 'required');
});

test('userStatements keeps earlier statements and drops questions and replies', () => {
  const history = [
    { role: 'user', content: [{ type: 'input_text', text: 'Biscuit naps on the sunporch. Where do you nap?' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'Rex is a famous dog.' }] },
    { type: 'function_call_output', call_id: 'x', output: '{}' },
  ];
  assert.deepEqual(userStatements(history), ['Biscuit naps on the sunporch.']);
  assert.deepEqual(userStatements(), []);
  // Replayed history can carry plain text instead of content blocks.
  assert.deepEqual(userStatements([{ role: 'user', content: 'Biscuit snores.' }, { role: 'user' }]), ['Biscuit snores.']);
});

test('an explicit lookup is always explicit, and is flagged when it is about the household', () => {
  for (const message of ['Where does Biscuit nap? Look it up.', 'look up where Biscuit naps', 'look up where my dog naps', 'where does the dog nap, look it up', 'Please search the web for where my dog naps']) {
    const decision = classifyLookup(message);
    assert.equal(decision.level, 'explicit', message);
    assert.equal(decision.general_only, true, message);
  }
  for (const message of ['look up the Mets score', 'look up how many moons Mars has', 'look it up: how do I descale a kettle?', 'whats the biggest state? look it up', 'how tall is mount everest, look it up', 'look up who won the game', 'look up what time it is']) {
    const decision = classifyLookup(message);
    assert.equal(decision.level, 'explicit', message);
    assert.equal(decision.general_only, undefined, message);
  }
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
  assert.deepEqual(tracker.retrievedSources(), [{ url: 'https://forecast.weather.gov/x', title: 'NWS', basis: 'retrieved', snippet: 'private snippet' }], 'the person sees result text as context');
  const summary = tracker.summary();
  assert.deepEqual([summary.searches, summary.failed_searches, summary.state], [1, 1, 'done']);
  assert.ok(!JSON.stringify(summary).includes('private snippet'), 'but result text stays out of traces and summaries');
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

test('household directives keep web text out, and only flagged results need the code-written label', () => {
  const home = new LookupTracker();
  home.setPolicy(classifyLookup('where does my dog nap?'));
  assert.equal(home.required, false);
  assert.match(lookupDirective(home), /Web search is off/);
  assert.equal(home.summary(), null);

  const unknown = new LookupTracker();
  unknown.setPolicy(classifyLookup('Where does Biscuit nap?'));
  assert.equal(unknown.required, false);
  assert.equal(unknown.state(), 'not_required');
  assert.match(lookupDirective(unknown), /do not search the web for it/);
  assert.match(lookupDirective(unknown), /search the web and answer from the results/, 'a famous name is still a web question');
  assert.equal(unknown.needsGeneralLabel, false, 'nothing to label until a search completes');
  unknown.record({ type: 'web_search_call', status: 'failed' });
  assert.equal(unknown.needsGeneralLabel, false, 'a failed search brought back no web text');
  unknown.record({ type: 'web_search_call', status: 'completed' });
  assert.equal(unknown.needsGeneralLabel, true);
  assert.match(lookupDirective(unknown), /Never present a result as a fact/);
  assert.equal(unknown.summary().labeled_general, true);

  const general = new LookupTracker();
  general.setPolicy(classifyLookup('how tall is mount everest?'));
  general.record({ type: 'web_search_call', status: 'completed' });
  assert.equal(general.needsGeneralLabel, false);
  assert.match(lookupDirective(general), /Never present a result as a fact/);
  assert.equal(general.summary().labeled_general, undefined);
});
