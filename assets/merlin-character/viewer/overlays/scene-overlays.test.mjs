import test from 'node:test';
import assert from 'node:assert/strict';
import {SceneOverlays} from './scene-overlays.js';
import {SceneClock} from '../scene-clock.js';
import {chooseClockSpot, overlapArea} from '../clock-layout.js';

// Record DOM effects without a browser, network, audio, or a running timer.
function environment(t, {reducedMotion = false} = {}) {
  class Element {
    constructor(tag = 'div') {
      this.tag = tag; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = new Map();
      this.children = []; this.selectors = new Map(); this.textContent = ''; this.hidden = false; this.disabled = false;
      this.inert = false; this.animations = []; this.clientWidth = 1000; this.clientHeight = 750;
    }
    set innerHTML(value) {
      this.markup = value; this.selectors.clear();
      for (const match of value.matchAll(/<([a-z]+)\b([^>]*)>/g)) {
        const [, tag, attributes] = match, node = new Element(tag);
        node.hidden = /\bhidden\b/.test(attributes);
        const classes = attributes.match(/\bclass="([^"]*)"/)?.[1]?.split(/\s+/) || [];
        for (const name of classes) this.selectors.set('.' + name, node);
        if (!this.selectors.has(tag)) this.selectors.set(tag, node);
      }
    }
    get innerHTML() { return this.markup || ''; }
    get offsetWidth() { return this.width ?? 270; }
    get offsetHeight() { return this.height ?? (this.className === 'scene-clock' ? 110 : 145); }
    append(node) { this.children.push(node); node.parent = this; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    querySelector(selector) { return this.selectors.get(selector) || null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(name, listener) { const listeners = this.listeners.get(name) || new Set(); listeners.add(listener); this.listeners.set(name, listeners); }
    removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
    dispatch(name) { for (const listener of this.listeners.get(name) || []) listener({type: name, target: this}); }
    animate(keyframes, options) {
      const animation = {keyframes, options, cancelled: false, cancel() {this.cancelled = true;}};
      this.animations.push(animation); return animation;
    }
  }
  const observers = [], scheduled = new Map(); let timerId = 0;
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(element) { this.targets.add(element); }
    unobserve(element) { this.targets.delete(element); }
    disconnect() { this.targets.clear(); this.disconnected = true; }
  }
  const document = new Element('document'); document.createElement = tag => new Element(tag); document.hidden = false;
  const values = {document, ResizeObserver, navigator: {language: 'en-US'}, matchMedia: () => ({matches: reducedMotion}),
    getComputedStyle: element => ({transform: element.style.transform || 'none'}),
    setTimeout: callback => {scheduled.set(++timerId, callback); return timerId;}, clearTimeout: id => scheduled.delete(id)};
  const cleanups = [], originals = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
  t.after(() => {
    try {for (const cleanup of cleanups.reverse()) cleanup();}
    finally {for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];}
  });
  return {stage: new Element(), document, observers, scheduled, cleanup: callback => cleanups.push(callback)};
}

function clockFixture() {
  const width = 1000, height = 750;
  const clock = chooseClockSpot({width, height, clockWidth: 270, clockHeight: 110});
  const listeners = new Set();
  return {listeners, layout: {width, height, clock, obstacles: [], hidden: false}, unsubscribed: 0,
    subscribeLayout(listener) { listeners.add(listener); listener(this.layout); return () => {listeners.delete(listener); this.unsubscribed++;}; },
    publish(patch) { this.layout = {...this.layout, ...patch}; for (const listener of listeners) listener(this.layout); },
  };
}

function fixture(t, options = {}) {
  const env = environment(t, options), clock = clockFixture(), overlays = new SceneOverlays(env.stage, {clock, presentation: options.presentation});
  env.cleanup(() => overlays.destroy());
  return {...env, clock, overlays, card: id => (overlays.rail || env.stage).children.find(element => element.dataset.overlayId === id)};
}

const rect = spot => ({left: spot.x, top: spot.y, right: spot.x + spot.width, bottom: spot.y + spot.height});
const timer = {title: 'Synthetic timer', status: 'running', remainingSeconds: 120, durationSeconds: 300};

test('companion rail retains every activity in face and small layouts without a new timer loop', t => {
  const h = fixture(t, {presentation: 'companion'});
  assert.equal(h.overlays.rail.hidden, true);
  for (let i = 0; i < 5; i++) h.overlays.show('timer', {...timer, title: `Timer ${i}`}, {id: `timer-${i}`});
  const nodes = [...h.overlays.rail.children];
  h.clock.publish({width: 358, height: 268.5, hidden: true, obstacles: [{left: 0, top: 0, right: 1, bottom: 1}]});
  h.overlays.setPresentation('face');
  assert.equal(h.overlays.rail.hidden, false);
  assert.equal(h.overlays.rail.tabIndex, 0);
  assert.equal(h.overlays.rail.dataset.presentation, 'face');
  assert.equal(h.overlays.rail.style.maxHeight, '53.7px');
  assert.ok(h.overlays.status.every(status => status.visible && status.spot === 'lower-right'));
  assert.equal(h.scheduled.size, 0);
  h.overlays.update('timer-0', {remainingSeconds: 90});
  assert.equal(h.card('timer-0').querySelector('.floating-countdown').textContent, '1:30');
  h.overlays.setPresentation('body');
  assert.deepEqual(h.overlays.rail.children, nodes, 'presentation changes keep the original cards and their identity');
  h.overlays.setPresentation('hidden');
  assert.equal(h.overlays.rail.hidden, true); assert.ok(h.overlays.status.every(status => !status.visible));
  h.overlays.setPresentation('face'); h.overlays.clear();
  assert.equal(h.overlays.rail.hidden, true); assert.equal(h.overlays.rail.children.length, 0);
  h.overlays.destroy(); assert.equal(h.stage.children.length, 0);
});

test('face controls disappear while accessible music metadata survives and body callbacks remain honest', t => {
  const h = fixture(t, {presentation: 'companion'}), requests = [];
  h.overlays.show('music', {title: 'Synthetic track', artist: 'Synthetic artist', status: 'playing'}, {onAction: action => requests.push(action)});
  const element = h.card('music'), button = element.querySelector('button');
  h.overlays.setPresentation('face');
  assert.equal(button.hidden, true); button.dispatch('click'); assert.equal(requests.length, 0);
  assert.match(element.getAttribute('aria-label'), /Synthetic artist/);
  h.overlays.setPresentation('body'); button.dispatch('click'); assert.equal(requests.length, 1);
  assert.equal(element.dataset.status, 'playing');
  assert.throws(() => h.overlays.setPresentation('elsewhere'), TypeError);
});

test('constructing the optional layer creates no cards, samples, polling, or action callbacks', t => {
  const {overlays, stage, observers, scheduled, clock} = fixture(t);
  assert.deepEqual(overlays.status, []); assert.equal(stage.children.length, 0); assert.equal(scheduled.size, 0);
  assert.equal(observers[0].targets.size, 0); assert.equal(clock.listeners.size, 1);
  clock.publish({hidden: true}); clock.publish({hidden: false});
  assert.equal(stage.children.length, 0); assert.equal(scheduled.size, 0);
});

test('missing values remain unknown and user strings are rendered only as text', t => {
  const h = fixture(t), literal = '<img src=x onerror=alert(1)> & “Tea”';
  h.overlays.show('timer', {title: literal});
  const card = h.card('timer');
  assert.equal(card.querySelector('.floating-title').textContent, literal);
  assert.equal(card.querySelector('.floating-title').title, literal);
  assert.equal(card.innerHTML.includes(literal), false);
  assert.equal(card.querySelector('.floating-countdown').textContent, '—');
  assert.equal(card.querySelector('.floating-status').textContent, 'Status unavailable');
  assert.equal(card.querySelector('progress').hidden, true);
  assert.equal(card.querySelector('button').hidden, true);
  h.overlays.update('timer', {remainingSeconds: 0, durationSeconds: 0});
  assert.equal(card.querySelector('.floating-countdown').textContent, '0:00');
  assert.equal(card.querySelector('.floating-status').textContent, 'Status unavailable');
  assert.equal(card.querySelector('progress').hidden, true);
});

test('controls send requests without optimistic state and updates retain the current callback', t => {
  const h = fixture(t), actions = [];
  h.overlays.show('timer', timer, {id: 'tea', onAction: value => actions.push(value)});
  const card = h.card('tea'), button = card.querySelector('button');
  assert.equal(button.hidden, false); assert.equal(button.disabled, false);
  button.dispatch('click');
  assert.deepEqual(actions, [{id: 'tea', type: 'timer', action: 'pause'}]);
  assert.equal(card.dataset.status, 'running'); assert.equal(card.querySelector('.floating-countdown').textContent, '2:00');
  assert.equal(h.overlays.update('tea', {status: 'paused', remainingSeconds: 98}), true);
  button.dispatch('click');
  assert.deepEqual(actions.at(-1), {id: 'tea', type: 'timer', action: 'resume'});
  assert.equal(card.dataset.status, 'paused'); assert.equal(card.querySelector('.floating-countdown').textContent, '1:38');
  for (const status of ['finished', 'unknown']) {
    h.overlays.update('tea', {status}); assert.equal(button.disabled, true); button.dispatch('click');
  }
  assert.equal(actions.length, 2); assert.equal(h.scheduled.size, 0, 'data never starts a countdown or polling loop');
});

test('hidden, removed, replaced, and destroyed cards cannot dispatch stale action requests', t => {
  const h = fixture(t), actions = [], onAction = value => actions.push(value);
  h.overlays.show('timer', timer, {id: 'tea', onAction});
  const first = h.card('tea').querySelector('button');
  h.clock.publish({hidden: true}); first.dispatch('click');
  assert.equal(actions.length, 0, 'a hidden presentation cannot receive actions');
  h.clock.publish({hidden: false}); h.overlays.hide('tea'); first.dispatch('click');
  assert.equal(actions.length, 0, 'a detached old card cannot receive actions');
  h.overlays.show('timer', timer, {id: 'tea', onAction}); first.dispatch('click');
  assert.equal(actions.length, 0, 'reusing an id does not reactivate its old element');
  const current = h.card('tea').querySelector('button'); current.dispatch('click'); assert.equal(actions.length, 1);
  h.overlays.destroy(); current.dispatch('click'); assert.equal(actions.length, 1, 'destruction revokes the callback');
});

test('clock and cards occupy separate anchors and temporarily hidden records retain their values', t => {
  const h = fixture(t);
  h.overlays.show('timer', timer, {id: 'tea'});
  h.overlays.show('music', {title: 'Synthetic track', artist: 'Synthetic artist', status: 'paused'}, {id: 'track'});
  const originalClock = structuredClone(h.clock.layout.clock);
  assert.equal(h.overlays.status.filter(status => status.visible).length, 2);
  const positions = [...h.overlays.cards.values()].map(card => card.spot);
  for (const spot of positions) assert.equal(overlapArea(rect(originalClock), rect(spot)), 0);
  assert.equal(overlapArea(rect(positions[0]), rect(positions[1])), 0);
  h.clock.publish({hidden: true});
  for (const element of h.stage.children) {assert.equal(element.inert, true); assert.equal(element.getAttribute('aria-hidden'), 'true');}
  assert.ok(h.overlays.status.every(status => !status.visible && status.reason === 'presentation'));
  h.overlays.update('tea', {remainingSeconds: 41});
  h.clock.publish({hidden: false, obstacles: [{left: 0, top: 0, right: 1, bottom: 1}]});
  assert.ok(h.overlays.status.every(status => !status.visible && status.reason === 'space'));
  h.clock.publish({obstacles: []});
  assert.ok(h.overlays.status.every(status => status.visible));
  assert.equal(h.card('tea').querySelector('.floating-countdown').textContent, '0:41');
  assert.equal(h.card('track').querySelector('.floating-title').textContent, 'Synthetic track');
  assert.deepEqual(h.clock.layout.clock, originalClock, 'optional cards never displace the clock');
});

test('clearing while hidden prevents resurrection and destruction removes every observer and node', t => {
  const h = fixture(t);
  h.overlays.show('timer', timer); h.overlays.show('music', {status: 'playing'});
  h.clock.publish({hidden: true}); h.overlays.clear();
  assert.deepEqual(h.overlays.status, []); assert.equal(h.stage.children.length, 0);
  assert.equal(h.observers[0].targets.size, 0);
  h.clock.publish({hidden: false}); h.observers[0].callback();
  assert.equal(h.stage.children.length, 0); assert.equal(h.overlays.update('timer', {remainingSeconds: 1}), false);
  h.overlays.show('timer', timer); const element = h.card('timer');
  h.overlays.destroy();
  assert.equal(element.parent, null); assert.equal(h.stage.children.length, 0); assert.equal(h.clock.listeners.size, 0);
  assert.equal(h.observers[0].disconnected, true); assert.equal(h.scheduled.size, 0);
  h.clock.publish({hidden: false}); h.observers[0].callback();
  assert.equal(h.stage.children.length, 0);
  assert.throws(() => h.overlays.show('timer', timer), /destroyed/);
});

test('invalid replacements leave the existing card and callback intact', t => {
  const h = fixture(t), actions = [];
  h.overlays.show('timer', timer, {id: 'tea', onAction: value => actions.push(value)});
  const element = h.card('tea');
  for (const action of [() => h.overlays.show('music', {}, {id: 'tea'}), () => h.overlays.show('timer', {}, {id: ' '}),
    () => h.overlays.show('timer', {}, {id: 'tea', onAction: true}), () => h.overlays.update('tea', [])]) assert.throws(action, TypeError);
  assert.equal(h.stage.children.length, 1); assert.equal(h.card('tea'), element);
  assert.equal(element.querySelector('.floating-countdown').textContent, '2:00');
  element.querySelector('button').dispatch('click'); assert.equal(actions.length, 1);
});

test('reduced motion and resize placement never start movement animations', t => {
  const h = fixture(t, {reducedMotion: true}); h.overlays.show('timer', timer);
  h.clock.publish({obstacles: [{left: .33, top: 0, right: .67, bottom: .4}]});
  assert.equal(h.card('timer').animations.length, 0);
  h.clock.publish({width: 800, height: 600, resize: true, clock: null, obstacles: []});
  assert.equal(h.card('timer').animations.length, 0);
});

test('hiding and removing cards cancel their active movement', t => {
  const h = fixture(t); h.overlays.show('timer', timer);
  h.clock.publish({obstacles: [{left: .33, top: 0, right: .67, bottom: .4}]});
  const element = h.card('timer'), movement = element.animations.at(-1);
  assert.ok(movement); assert.equal(movement.cancelled, false);
  h.clock.publish({hidden: true}); assert.equal(movement.cancelled, true);
  h.clock.publish({hidden: false, obstacles: []});
  h.clock.publish({obstacles: [{left: .68, top: 0, right: 1, bottom: .4}]});
  const nextMovement = element.animations.at(-1);
  assert.notEqual(nextMovement, movement); assert.equal(nextMovement.cancelled, false);
  h.overlays.hide('timer'); assert.equal(nextMovement.cancelled, true); assert.equal(element.parent, null);
});

test('SceneClock publishes stationary visibility and obstacle changes and releases subscribers', t => {
  const h = environment(t), states = {ready: {idle: 'Ready'}, face: {parent: 'ready', enter: 'EnterFace', idle: 'Face', exit: 'LeaveFace'}};
  const footprints = new Map([['Ready', []], ['Face', []]]), clock = new SceneClock(h.stage, states, footprints);
  h.cleanup(() => clock.destroy());
  const events = [], unsubscribe = clock.subscribeLayout(layout => events.push(layout));
  assert.equal(events.length, 0, 'no fabricated layout before the first motion snapshot');
  clock.sync({current: 'ready', desired: 'ready', phase: 'idle', clip: 'Ready'});
  const first = clock.spot; assert.equal(events.length, 1); assert.equal(events[0].hidden, false);
  const secondEvents = [], unsubscribeSecond = clock.subscribeLayout(layout => secondEvents.push(layout));
  assert.equal(secondEvents.length, 1, 'late subscribers receive the current layout');
  clock.sync({current: 'face', desired: 'face', phase: 'idle', clip: 'Face'});
  assert.equal(events.at(-1).hidden, true); assert.equal(clock.spot.id, first.id, 'a stationary clock still publishes face hiding');
  footprints.set('Ready', [{left: .4, top: .4, right: .6, bottom: .6}]);
  clock.sync({current: 'ready', desired: 'ready', phase: 'idle', clip: 'Ready'});
  assert.equal(events.at(-1).hidden, false); assert.equal(events.at(-1).obstacles.length, 1); assert.equal(clock.spot.id, first.id);
  unsubscribe(); unsubscribeSecond(); const count = events.length; clock.place(true); assert.equal(events.length, count);
  clock.destroy(); assert.equal(clock.layoutListeners.size, 0); assert.equal(h.scheduled.size, 0);
  assert.equal(h.stage.children.length, 0); assert.equal(h.observers[0].disconnected, true);
});
