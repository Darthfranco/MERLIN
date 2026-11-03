import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { ConnectorHub, homeReply } from '../src/connectors/hub.js';
import { createConnectors } from '../src/connectors/index.js';
import { demoHome } from '../src/connectors/demo-home.js';
import { classifyConnectionIntent } from '../src/connection-intents.js';
import { connectionState, presentationResult } from '../src/companion.js';
import { Orchestrator } from '../public/companion/orchestrator.js';

const call = (name, args, call_id = randomUUID()) => ({ type: 'function_call', status: 'completed', name, arguments: JSON.stringify(args), call_id });
const reply = text => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] });
const fakeSpotify = { status: () => ({ configured: false, connected: false }) };

function scriptedMeta(steps) {
  return {
    configured: true, model: 'synthetic-demo-home', calls: [],
    async respond(input, tools, instructions) {
      this.calls.push({ tools: tools.map(tool => tool.name ?? tool.type), instructions });
      assert.ok(steps.length, 'Unexpected extra model invocation');
      return structuredClone(steps.shift());
    },
  };
}

async function demoHub(t) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-demo-home-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hub = await new ConnectorHub({ filePath: join(directory, 'connectors.json'), connectors: [demoHome()] }).init();
  await hub.connect('demo-home', {});
  return hub;
}

async function demoApp(t, meta, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-demo-app-'));
  const app = await createApp({ dataDir: directory, meta, learningDelayMs: 60000, ...options });
  t.after(async () => { await app.learning.close(); await rm(directory, { recursive: true, force: true }); });
  const ask = async message => (await app.runChatTurn({ message, session_id: randomUUID(), request_id: randomUUID(), time_zone: 'America/New_York', channel: 'voice' })).data;
  return { app, ask, directory };
}

test('the demo home exists only when it is explicitly turned on', () => {
  assert.equal(createConnectors({ spotify: null }).some(connector => connector.id === 'demo-home'), false);
  const added = createConnectors({ spotify: null, demoHome: true }).find(connector => connector.id === 'demo-home');
  assert.equal(added.simulated, true);
  assert.match(added.summary, /Simulated/);
  assert.match(added.summary, /Nothing physical/);
});

test('demo devices act through the hub with labeled receipts and the state the panel may paint', async t => {
  const hub = await demoHub(t);
  assert.deepEqual(hub.tools().map(tool => tool.name), ['home_list_devices', 'home_get_state', 'home_control']);
  assert.match(hub.instructions(), /Demo home is a simulated demonstration home/);
  for (const category of ['lights', 'speakers', 'appliances']) assert.ok(hub.coveredCategories().has(category), category);

  const lights = await hub.executeTool('home_control', { device: 'gym lights', action: 'turn_on' });
  assert.equal(lights.status, 'confirmed');
  assert.equal(lights.message, 'Turned on Gym lights in the demo home.');
  assert.deepEqual(lights.device, { id: 'demo-home:gym-lights', name: 'Gym lights', kind: 'light', room: 'Gym', state: { on: true, brightness: 100 }, simulated: true });

  const oven = await hub.executeTool('home_control', { device: 'the oven', action: 'preheat', value: 400 });
  assert.equal(oven.message, 'Started preheating Oven to 400 °F in the demo home.');
  assert.deepEqual(oven.device.state, { on: true, temperature: 400, unit: '°F' });
  const read = await hub.executeTool('home_get_state', { device: 'oven' });
  assert.deepEqual(read.state, { on: true, temperature: 400, unit: '°F' });

  const off = await hub.executeTool('home_control', { device: 'oven', action: 'turn_off' });
  assert.deepEqual(off.device.state, { on: false, unit: '°F' });
  const speaker = await hub.executeTool('home_control', { device: 'gym speaker', action: 'toggle' });
  assert.deepEqual(speaker.device.state, { on: true });
});

test('demo outcomes share one spoken label and keep the rest of the reply', async t => {
  const hub = await demoHub(t);
  const lights = await hub.executeTool('home_control', { device: 'gym lights', action: 'turn_on' });
  const speaker = await hub.executeTool('home_control', { device: 'gym speaker', action: 'turn_on' });
  assert.equal(homeReply('Righto! Today is legs: squats five by five. Your gym lights and speaker are on.', [lights, speaker]),
    'Righto! Today is legs: squats five by five. Turned on Gym lights and turned on Gym speaker in the demo home.');
  const oven = await hub.executeTool('home_control', { device: 'oven', action: 'preheat', value: 400 });
  assert.equal(homeReply('Splendid! Your oven is preheating to four hundred degrees.', [oven]), 'Splendid! Started preheating Oven to 400 °F in the demo home.');
  const failed = await hub.executeTool('home_control', { device: 'oven', action: 'preheat', value: 900 });
  assert.equal(homeReply('Done!', [failed, lights]), `${failed.message} Turned on Gym lights in the demo home.`);
});

test('the demo oven keeps its bounds, and ambiguous or unknown names are not guessed', async t => {
  const hub = await demoHub(t);
  for (const value of [600, 100, undefined]) {
    const result = await hub.executeTool('home_control', { device: 'oven', action: 'preheat', value });
    assert.equal(result.ok, false, String(value));
    assert.match(result.message, /170 to 550/);
  }
  const state = await hub.executeTool('home_get_state', { device: 'oven' });
  assert.equal(state.state.on, false, 'a rejected preheat changes nothing');
  const vague = await hub.executeTool('home_control', { device: 'lights', action: 'turn_on' });
  assert.equal(vague.ok, false);
  assert.match(vague.message, /More than one device/);
  const unknown = await hub.executeTool('home_control', { device: 'garage door', action: 'open' });
  assert.equal(unknown.ok, false);
  const unsupported = await hub.executeTool('home_control', { device: 'gym speaker', action: 'preheat', value: 350 });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.message, /can’t preheat/);
});

test('home receipts become lights, oven and speaker panels, and nothing else does', () => {
  const panel = (device, extra = {}) => presentationResult('tool_result', { tool: 'home_control', ok: true, result: { ok: true, status: 'confirmed', confirmed: true, device, ...extra } });
  assert.deepEqual(panel({ id: 'demo-home:gym-lights', name: 'Gym lights', kind: 'light', state: { on: true }, simulated: true }),
    { type: 'lights', id: 'demo-home:gym-lights', label: 'Gym lights', status: 'on', simulated: true });
  assert.deepEqual(panel({ id: 'demo-home:oven', name: 'Oven', kind: 'oven', state: { on: true, temperature: 400, unit: '°F' }, simulated: true }),
    { type: 'oven', id: 'demo-home:oven', label: 'Oven', status: 'on', detail: 'Preheating to 400°F', simulated: true });
  assert.deepEqual(panel({ id: 'demo-home:gym-speaker', name: 'Gym speaker', kind: 'media', state: { on: false } }),
    { type: 'speaker', id: 'demo-home:gym-speaker', label: 'Gym speaker', status: 'off' });
  // A real service that only accepted the command, or reported nothing, never paints a state.
  assert.equal(panel({ id: 'hue:1', name: 'Desk lamp', kind: 'light' }, { status: 'accepted', confirmed: false }).status, 'pending');
  assert.equal(panel({ id: 'hue:1', name: 'Desk lamp', kind: 'light' }).status, 'pending');
  assert.equal(panel({ id: 'ha:switch.fan', name: 'Fan', kind: 'fan', state: { on: true } }), null);
  assert.equal(presentationResult('tool_result', { tool: 'home_control', ok: false }), null);
  assert.equal(presentationResult('tool_result', { tool: 'home_control', ok: true, result: { ok: true, message: 'Turned on Lamp.' } }), null);
});

test('services report a category as simulated only when the demo home alone covers it', async t => {
  const hub = await demoHub(t);
  const services = connectionState(fakeSpotify, hub);
  assert.deepEqual(services.lights, { available: true, connected: true, status: 'connected', simulated: true });
  assert.deepEqual(services.oven, { available: true, connected: true, status: 'connected', simulated: true });

  const directory = await mkdtemp(join(tmpdir(), 'merlin-demo-real-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const realLights = { id: 'real-lights', name: 'Real Lights', summary: 'Real', kinds: ['light'], fields: [], publicConfig: () => ({}),
    async connect() { return { config: {}, summary: 'ok' }; }, async verify() { return { summary: 'ok' }; }, async devices() { return []; }, async disconnect() { return { revoked: true, message: '' }; } };
  const mixed = await new ConnectorHub({ filePath: join(directory, 'connectors.json'), connectors: [realLights, demoHome()] }).init();
  await mixed.connect('demo-home', {});
  await mixed.connect('real-lights', {});
  const both = connectionState(fakeSpotify, mixed);
  assert.equal(both.lights.simulated, undefined);
  assert.equal(both.oven.simulated, true);
});

test('covered demo categories leave device requests to the device tools', () => {
  const covered = new Set(['lights', 'speakers', 'appliances']);
  for (const message of ['Turn on the living room lights.', 'Preheat the oven to 400 degrees.', 'Turn on the kitchen lights and preheat the oven to 375.']) {
    assert.equal(classifyConnectionIntent(message, { coveredCategories: covered })?.kind, undefined, message);
    assert.equal(classifyConnectionIntent(message).kind, 'unconnected', message);
  }
});

test('the orchestrator places two device panels from one routine and keeps their identity', () => {
  const o = new Orchestrator({ now: () => 0, render: () => {} });
  const presentation = [
    { type: 'lights', id: 'demo-home:gym-lights', label: 'Gym lights', status: 'on', simulated: true },
    { type: 'speaker', id: 'demo-home:gym-speaker', label: 'Gym speaker', status: 'on', simulated: true },
  ];
  o.begin('gym');
  o.progress('gym', [{ stage: 'tool_start', tool: 'home_control' }]);
  assert.equal(o.pending.panel.type, 'lights');
  o.result('gym', { reply: 'Turned on Gym lights.', tool_events: [{ tool: 'routine_use', status: 'completed' }, { tool: 'home_control', status: 'completed' }, { tool: 'home_control', status: 'completed' }], presentation });
  assert.deepEqual(Object.values(o.panels).map(panel => panel?.id).sort(), ['demo-home:gym-lights', 'demo-home:gym-speaker']);
  assert.equal(o.bodyLayout, 'both');
  // A later "turn off the gym lights" replaces the same panel instead of taking another slot.
  o.reply('gym'); o.standby();
  o.begin('off');
  o.result('off', { reply: 'Turned off Gym lights.', tool_events: [{ tool: 'home_control', status: 'completed' }], presentation: [{ ...presentation[0], status: 'off' }] });
  assert.equal(Object.values(o.panels).find(panel => panel?.id === 'demo-home:gym-lights').status, 'off');
  assert.equal(Object.values(o.panels).filter(Boolean).length, 2);
  // A failed device action paints nothing.
  o.begin('fail');
  o.result('fail', { reply: 'That did not run.', tool_events: [{ tool: 'home_control', status: 'failed' }], presentation: [] });
  assert.equal(o.view.label, 'That action needs attention');
});

test('with the demo home on, a voice request turns on a labeled light and its panel, without the connection screen', async t => {
  const meta = scriptedMeta([
    [call('home_control', { device: 'living room lights', action: 'turn_on', value: null })],
    [reply('All done, the living room lights are on!')],
  ]);
  const { ask, directory } = await demoApp(t, meta, { demoHome: true });
  const data = await ask('Turn on the living room lights.');
  assert.ok(meta.calls[0].tools.includes('home_control'));
  assert.match(meta.calls[0].instructions, /simulated demonstration home/);
  assert.equal(data.reply, 'Turned on Living room lights in the demo home.');
  assert.deepEqual(data.presentation, [{ type: 'lights', id: 'demo-home:living-room-lights', label: 'Living room lights', status: 'on', simulated: true }]);
  assert.equal(data.tool_events.some(event => event.tool === 'show_connections'), false);
  const saved = JSON.parse(await readFile(join(directory, 'connectors.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.connectors), ['demo-home']);
  assert.deepEqual(saved.connectors['demo-home'].config, { simulated: true });
});

test('without the flag nothing is simulated: the same request still opens the connection screen', async t => {
  const meta = scriptedMeta([[reply('Nothing is connected yet.')]]);
  const { app, ask } = await demoApp(t, meta, { demoHome: false });
  assert.equal(app.connections.has('demo-home'), false);
  const data = await ask('Turn on the living room lights.');
  assert.equal(meta.calls[0].tools.includes('home_control'), false);
  assert.ok(data.presentation.some(card => card.type === 'connections'));
});
