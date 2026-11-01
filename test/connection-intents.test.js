import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyConnectionIntent, namedRoutes, categoryFor, CATEGORY_IDS } from '../src/connection-intents.js';

const classify = (message, options) => classifyConnectionIntent(message, options);

test('asking how to connect something opens the setup help for that route or category', () => {
  const ring = classify('How do I connect my Ring doorbell?');
  assert.deepEqual([ring.kind, ring.entry, ring.category], ['how_to', 'ring', 'cameras']);
  assert.equal(classify('can you connect to my Philips Hue lights').entry, 'philips-hue');
  assert.equal(classify('I want to set up Sonos').entry, 'sonos');
  assert.equal(classify('help me pair my Roomba').entry, 'irobot');
  assert.equal(classify('connect my ecobee thermostat').entry, 'ecobee');
  const lights = classify('how do I set up my smart lights?');
  assert.deepEqual([lights.kind, lights.category, lights.entry], ['how_to', 'lights', '']);
  assert.equal(classify('how can I add my thermostat').category, 'climate');
  assert.equal(classify('How do I connect my smart lock').category, 'locks');
  assert.equal(classify('link my Alexa').entry, 'amazon-echo');
});

test('a brand with several routes becomes a search rather than a guess', () => {
  const google = classify('how do I connect my Google devices');
  assert.equal(google.kind, 'how_to');
  assert.equal(google.entry, '');
  assert.equal(google.query, 'google');
});

test('browsing questions open the full list', () => {
  for (const message of ['what can you connect to?', 'What devices work with you', 'show me the connections', 'open the integrations', 'connect a device', 'what smart home brands can you pair with', 'add a new device']) {
    assert.equal(classify(message)?.kind, 'browse', message);
  }
  assert.equal(classify('what lights can you connect to').category, 'lights');
});

test('asking for something never connected opens the matching category', () => {
  const cases = {
    'turn on the living room lights': 'lights', 'please turn off the lights': 'lights', 'dim the bedroom lamp': 'lights', 'lights off': 'lights',
    'preheat the oven to 400': 'appliances', 'turn on the dishwasher': 'appliances', 'start the washing machine': 'appliances',
    'set the AC to 68': 'climate', 'turn up the thermostat': 'climate', 'make it cooler in here': 'climate',
    'show me the front door': 'cameras', "who's at the door?": 'cameras', 'check the backyard camera': 'cameras',
    'lock the front door': 'locks', 'unlock the back door': 'locks', 'close the garage door': 'garage', 'open the garage': 'garage',
    'close the blinds': 'blinds', 'start the vacuum': 'vacuums', 'turn off the tv': 'tvs', 'turn on the kitchen plug': 'plugs',
    'water the lawn': 'garden',
  };
  for (const [message, category] of Object.entries(cases)) {
    const intent = classify(message);
    assert.deepEqual([intent?.kind, intent?.category], ['unconnected', category], message);
  }
});

test('music needs a connected service only when Spotify is not connected', () => {
  assert.deepEqual(['unconnected', 'music'], [classify('play some jazz').kind, classify('play some jazz').category]);
  assert.equal(classify('put on a playlist').kind, 'unconnected');
  assert.equal(classify('play some jazz', { spotifyConnected: true }), null);
  assert.equal(classify('play some jazz', { spotifyAvailable: false }), null);
});

test('a category a verified connector covers does not reopen the panel, an uncovered one does', () => {
  assert.equal(classify('turn on the lights', { coveredCategories: new Set(['lights']) }), null, 'the device tools handle it');
  const intent = classify('turn on the lights', { coveredCategories: new Set(['plugs', 'locks']) });
  assert.deepEqual([intent.kind, intent.category], ['unconnected', 'lights']);
  assert.equal(classify('turn on the lights').kind, 'unconnected');
});

test('timers, routines, conversation, weather, and lookups never open the panel', () => {
  for (const message of [
    'set a 5 minute timer', 'set up a routine for the gym', 'add a timer for the oven', 'add milk to my shopping list', 'remind me to turn off the lights',
    'hello', "what's the weather", 'what is the capital of France', 'what time is it', 'look up how to descale a kettle', 'thanks!', '',
    "don't show the connections", 'what timers are running', 'add a routine called coffee', 'how do I connect the dots',
  ]) assert.equal(classify(message), null, JSON.stringify(message));
});

test('named routes use brand words and ignore ordinary speech', () => {
  assert.deepEqual(namedRoutes('connect Ring').ids, ['ring']);
  assert.deepEqual(namedRoutes('the ring on my finger is nice').ids, ['ring']);
  assert.deepEqual(namedRoutes('what is the matter with the bridge in the beam era').ids, []);
  assert.deepEqual(namedRoutes('I use Zigbee and Z-Wave').ids.sort(), ['z-wave', 'z-wave-thermostats', 'zigbee']);
  assert.ok(namedRoutes('add Nest').ids.length >= 2);
});

test('categories come from household nouns and are valid panel categories', () => {
  assert.equal(categoryFor('my smart bulbs'), 'lights');
  assert.equal(categoryFor('the dishwasher'), 'appliances');
  assert.equal(categoryFor('nothing relevant here'), '');
  for (const message of ['turn on the lights', 'close the garage door', 'play music']) assert.ok(CATEGORY_IDS.has(categoryFor(message)));
});

test('the intent never echoes the user text', () => {
  const secret = 'my password is hunter2';
  const intent = classify(`how do I connect my Ring ${secret}`);
  assert.ok(!JSON.stringify(intent).includes('hunter2'));
});
