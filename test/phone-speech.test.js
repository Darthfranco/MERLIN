import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import { createInitialState, normalizeState, respond, removeMemory } from '../public/phone/demo-engine.js';
import { normalizeSpokenText } from '../public/shared/spoken-text.js';

async function fixture() {
  const elements = new Map(), utterances = [], timers = [], saved = new Map();
  const node = () => ({
    value: '', textContent: '', hidden: false, dataset: {}, style: {}, children: [],
    classList: { add() {}, toggle() {} },
    addEventListener() {}, setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
  });
  const element = id => {
    if (!elements.has(id)) elements.set(id, node());
    return elements.get(id);
  };
  const localVoice = { localService: true, lang: 'en-US', name: 'Synthetic local voice' };
  const speechSynthesis = { getVoices: () => [localVoice], cancel() {}, speak: utterance => utterances.push(utterance) };
  const context = createContext({
    createInitialState, normalizeState, respond, removeMemory, normalizeSpokenText,
    SERVICES: [], DEFAULT_CONNECTED_IDS: [], getService() {}, icon: () => '', hydrateIcons() {},
    saveFile: async () => {}, readFile: async () => {}, deleteFile: async () => {}, clearFiles: async () => {},
    MAX_FILE_SIZE: 10_000_000, MAX_TOTAL_SIZE: 50_000_000,
    document: { getElementById: element, createElement: node, querySelectorAll: () => [], addEventListener() {}, hidden: false },
    window: { speechSynthesis, addEventListener() {} }, speechSynthesis,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    location: { hash: '' }, requestAnimationFrame: callback => callback(), URL,
    clearTimeout() {}, setTimeout(callback, delay) {
      timers.push({ callback, delay });
      if (delay === 450 || delay === 700) queueMicrotask(callback);
      return timers.length;
    },
  });
  // Execute the actual browser controller with injected imports and local browser
  // APIs. No microphone, remote voice, real account, or device action is involved.
  const source = await readFile(new URL('../public/phone/app.js', import.meta.url), 'utf8');
  assert.match(source, /import\s*\{normalizeSpokenText\}\s*from\s*'\.\.\/shared\/spoken-text\.js'/u);
  runInContext(source.replace(/^import .*;\r?\n/gmu, ''), context);
  return { element, utterances, timers, saved, localVoice, run: code => runInContext(code, context) };
}

test('phone speech expands units and amounts while captions, history and stored demo data keep the original reply', async () => {
  const ui = await fixture();
  ui.run(`respond(state, 'Remember my note says 16°F and $12.50.', {channel:'text'}); currentView='talk'; soundEnabled=true;`);
  await ui.run(`submit('What do you remember about me?', {channel:'voice', preview:true})`);
  assert.equal(ui.utterances.length, 1);
  const canonical = ui.run('state.messages.at(-1).text');
  assert.match(canonical, /16°F and \$12\.50/u);
  assert.equal(ui.element('voice-caption').textContent, canonical);
  assert.equal(JSON.parse(ui.saved.get('merlin-phone-demo-v1')).messages.at(-1).text, canonical);
  assert.equal(ui.utterances[0].text, normalizeSpokenText(canonical));
  assert.match(ui.utterances[0].text, /16 degrees Fahrenheit and 12 dollars and 50 cents/u);
  assert.doesNotMatch(ui.utterances[0].text, /°F|\$/u);
  assert.equal(ui.utterances[0].voice, ui.localVoice);
  assert.equal(ui.utterances[0].rate, 1);
});

test('muting phone replies keeps the displayed reply without requesting spoken playback', async () => {
  const ui = await fixture();
  ui.run(`respond(state, 'Remember my note says 16°F and $12.50.', {channel:'text'}); currentView='talk';`);
  await ui.run(`submit('What do you remember about me?', {channel:'voice', preview:true})`);
  assert.equal(ui.utterances.length, 0);
  assert.match(ui.element('voice-caption').textContent, /16°F and \$12\.50/u);
});
