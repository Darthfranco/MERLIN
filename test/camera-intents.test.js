import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCameraIntent, isCameraOffer, parseCameraConsent } from '../src/camera-intents.js';

test('someone showing MERLIN something means the device camera', () => {
  const asks = {
    'Does my outfit match?': 'outfit', 'does my outfit match': 'outfit', 'how do I look': 'outfit', "what do you think of my outfit?": 'outfit', 'rate my clothes': 'outfit',
    'Do these shoes go with this?': 'outfit', 'does this shirt go with these pants?': 'outfit', 'do these match?': 'outfit', 'does my shirt match my pants?': 'outfit', 'what am I wearing?': 'outfit',
    'does my ring match my outfit?': 'outfit', 'how many calories is this?': 'food', 'how many calories are in these?': 'food', "what's on my plate?": 'food',
    'help me with this homework': 'homework', 'look at my homework': 'homework', 'can you check this math problem?': 'homework',
    'what is this?': 'object', "what's that": 'object', 'Merlin, what is this thing?': 'object', 'what am I holding?': 'object', 'identify this': 'object',
    'turn on the camera': 'general', 'use your camera': 'general', 'open the camera': 'general', 'look through your camera': 'general', 'what do you see?': 'general', 'can you see me?': 'general', 'look at this': 'general',
  };
  for (const [message, topic] of Object.entries(asks)) {
    const intent = classifyCameraIntent(message);
    assert.equal(intent?.kind, 'device', message);
    assert.equal(intent.topic, topic, message);
    assert.equal(intent.refused_home, false, message);
  }
});

test('doorbells, rooms and home cameras are never the device camera', () => {
  for (const message of ["Who's at the door?", 'who is at the front door', 'is anyone at the door', 'is someone on the porch', 'who rang', 'show me the living room', 'show me the front door', 'check the backyard camera',
    'show me the living room camera', 'pull up the doorbell', 'check the ring', 'open the Ring camera', 'check the nest cam', 'show me the cameras', 'is there a package on the porch', 'look at the driveway', 'view the nursery', 'turn on the doorbell camera']) {
    assert.deepEqual(classifyCameraIntent(message), { kind: 'home' }, message);
  }
});

test('using a doorbell to look at what someone is showing stays the device camera, and is flagged', () => {
  for (const message of ['check my outfit with the ring doorbell', 'does my outfit match on the front door camera', 'use the camera on the doorbell to see if these shoes look good']) {
    const intent = classifyCameraIntent(message);
    assert.equal(intent.kind, 'device', message);
    assert.equal(intent.refused_home, true, message);
  }
});

test('talk that does not need eyes stays out of it', () => {
  for (const message of ['does navy go with brown', 'does my blue shirt match my brown pants?', 'what should I wear to a wedding?', 'what is the capital of France', 'what is this song', 'how many calories in an apple', 'set a timer for 5 minutes',
    'look at my schedule', 'look at my calendar', 'what do you think of this idea', 'how do I connect my Ring', 'set up the doorbell', 'can you connect a camera?', 'do you have a camera?', 'is your camera on?', 'which cameras work?',
    'never use the camera', "don't use your camera", 'turn the camera off', 'turn off your camera', 'no camera please', 'I bought this shirt', 'remember that my outfit looks good in navy', 'look at this https://example.com/a', 'hello', '', '   ']) {
    assert.equal(classifyCameraIntent(message), null, message);
  }
});

test('the question and what to find come from the request, in SAM-sized concepts', () => {
  assert.deepEqual(classifyCameraIntent('Does this tie go with this jacket?').find, ['tie', 'jacket']);
  assert.deepEqual(classifyCameraIntent('does my outfit match?').find, ['shirt', 'pants', 'shoes', 'dress']);
  assert.deepEqual(classifyCameraIntent('what is this?').find, [], 'with nothing concrete to search for, Muse names it first');
  assert.equal(classifyCameraIntent('  Does my outfit match?  ').question, 'Does my outfit match?');
});

test('a request that also asks for other work goes to the model', () => {
  assert.equal(classifyCameraIntent('does my outfit match?').pure, true);
  assert.equal(classifyCameraIntent('Merlin. Does my outfit match?').pure, true);
  assert.equal(classifyCameraIntent('do my shirt and these pants match?').pure, true);
  assert.equal(classifyCameraIntent('does my outfit match and set a timer for five minutes').pure, false);
  assert.equal(classifyCameraIntent('Set a timer. Does my outfit match?').pure, false);
});

test('only a whole plain yes is consent', () => {
  for (const message of ['yes', 'Yes.', 'yes please', 'yeah', 'yep', 'sure', 'ok', 'okay', 'go ahead', 'do it', 'sure go ahead', 'please do', 'of course', 'turn it on', 'yes turn it on', 'Yes, turn on the camera.', 'use the camera', 'take a look', 'yes merlin', 'ok merlin', 'sure, thanks']) {
    assert.equal(parseCameraConsent(message), 'yes', message);
  }
  for (const message of ['no', 'No.', 'nope', 'nah', 'not now', 'not yet', 'no thanks', "don't", 'do not', 'never mind', 'cancel', 'stop', 'leave it off', 'maybe later', 'No, leave the camera off.', 'no go ahead', "please don't"]) {
    assert.equal(parseCameraConsent(message), 'no', message);
  }
  for (const message of ['maybe', 'what?', 'yes but only my shirt', 'yes and set a timer', 'why', 'how much does that cost', 'yes I think you should not', '', 'what time is it', 'ok so what do you think about the weather today']) {
    assert.equal(parseCameraConsent(message), null, message);
  }
});

test('a camera question in the model\'s own words is recognized, and other mentions are not', () => {
  for (const reply of ['Shall I turn on the camera?', 'Want me to use my camera to check?', 'Would you like me to switch on the camera and take a look?', 'Should I have the camera turned on for this?']) assert.equal(isCameraOffer(reply), true, reply);
  for (const reply of ['I turned on the camera.', 'The camera is off.', 'What colour is it?', 'Your timer is set.', '']) assert.equal(isCameraOffer(reply), false, reply);
});
