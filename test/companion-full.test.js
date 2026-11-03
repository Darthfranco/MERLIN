import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { companionAsset } from '../src/companion.js';
import { createDemoState, panelActions, PANEL_HEIGHT, PANEL_WIDTH } from '../assets/merlin-character/viewer/panels/render.js';
import { connectionTargets } from '../assets/merlin-character/viewer/panels/connections.js';
import { playOfferTargets } from '../assets/merlin-character/viewer/panels/play-offer.js';
import { panelState, initialUi } from '../public/companion/connections-panel.js';

const ROOT = resolve(import.meta.dirname, '..');

test('/companionfull/ serves the same companion page marked as the full-screen home display', async () => {
  for (const path of ['/companionfull', '/companionfull/']) {
    const asset = await companionAsset(ROOT, path);
    const html = asset.content.toString('utf8');
    assert.equal(asset.type, 'text/html; charset=utf-8');
    assert.match(html, /<html lang="en" data-mode="full">/);
    assert.match(html, /viewport-fit=cover,user-scalable=no/);
    assert.match(html, /apple-mobile-web-app-capable/);
    assert.match(html, /<title>MERLIN<\/title>/);
    assert.match(html, /id="full-start"/);
    assert.match(html, /id="full-mic"/);
    assert.equal(asset.hashes.length, 1, 'the import map hash is still allowed by the page policy');
  }
  const normal = (await companionAsset(ROOT, '/companion/')).content.toString('utf8');
  assert.doesNotMatch(normal, /data-mode="full"/);
  assert.equal(await companionAsset(ROOT, '/companionfull/app.js'), null);
  assert.equal(await companionAsset(ROOT, '/companionfull/../.env'), null);
});

test('touch panels draw only real actions, always offer a close button, and make every tap area large', () => {
  const ids = state => panelActions(state, { touch: true }).map(action => action.id);
  assert.deepEqual(ids({ ...createDemoState('timer'), status: 'running' }), ['cancel', 'close']);
  assert.deepEqual(ids({ ...createDemoState('timer'), status: 'done' }), ['dismiss', 'close']);
  assert.deepEqual(ids({ type: 'lights', status: 'on', label: 'Gym lights' }), ['toggle', 'close']);
  assert.equal(panelActions({ type: 'lights', status: 'on', label: 'Gym lights' }, { touch: true })[0].label, 'Turn off Gym lights');
  assert.deepEqual(ids({ type: 'oven', status: 'pending', label: 'Oven' }), ['close'], 'no toggle until the device reports a state');
  assert.deepEqual(ids({ ...createDemoState('music'), status: 'playing' }), ['previous', 'toggle', 'next', 'close']);
  assert.deepEqual(ids({ ...createDemoState('music'), status: 'empty' }), ['close']);
  assert.deepEqual(ids(createDemoState('routine')), ['close'], 'routines are run by voice, not by a panel button');
  for (const state of [createDemoState('timer'), { type: 'speaker', status: 'off', label: 'Gym speaker' }, { ...createDemoState('music'), status: 'paused' }]) {
    for (const action of panelActions(state, { touch: true })) {
      const { hit } = action;
      assert.ok(hit.x <= action.x && hit.y <= action.y && hit.x + hit.w >= action.x + action.w && hit.y + hit.h >= action.y + action.h, `${state.type} ${action.id} hit covers the drawing`);
      assert.ok(hit.x >= 0 && hit.y >= 0 && hit.x + hit.w <= PANEL_WIDTH && hit.y + hit.h <= PANEL_HEIGHT, `${state.type} ${action.id} stays on the panel`);
      // About a quarter of the iPad's width per panel: 200 design units is roughly 45 points.
      assert.ok(Math.min(hit.w, hit.h) >= 200, `${state.type} ${action.id} is large enough to tap`);
    }
  }
  // The authored previews keep their original small controls.
  assert.deepEqual(panelActions({ ...createDemoState('timer'), status: 'running' }).map(action => action.id), ['toggle', 'cancel']);
});

test('the big screens get a large close button only on the home display', () => {
  const ui = panelState(initialUi({ category: 'lights' }), { connectors: [], spotify: { connected: false } });
  assert.equal(connectionTargets(ui, 1600, 900).some(target => target.action === 'close'), false);
  const close = connectionTargets({ ...ui, closable: true }, 1600, 900).find(target => target.action === 'close');
  assert.ok(close && close.w >= 200 && close.h >= 130, 'large close area');
  assert.ok(close.x + close.w <= 1600 && close.y === 0);
  // It stays above the category chips (which start at about 16% of the height).
  assert.ok(close.y + close.h <= .16 * 900);
  assert.equal(playOfferTargets({ title: 'Workout', status: 'ready' }, 1600, 900).some(target => target.action === 'close'), false);
  assert.ok(playOfferTargets({ title: 'Workout', status: 'ready', closable: true }, 1600, 900).some(target => target.action === 'close'));
});

test('a tap on a device panel goes through the hub and its rules, and returns the panel to paint', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-full-'));
  const app = await createApp({ dataDir: directory, meta: { configured: false }, demoHome: true, learningDelayMs: 60000 });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    await new Promise(done => { app.server.close(done); app.server.closeAllConnections(); });
    await app.learning.close(); await rm(directory, { recursive: true, force: true });
  });
  const port = app.server.address().port;
  const post = body => new Promise((done, fail) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/api/home/control', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => done({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', fail); req.end(JSON.stringify(body));
  });
  const on = await post({ request_id: randomUUID(), connector: 'demo-home', device: 'Gym lights', action: 'turn_on' });
  assert.equal(on.status, 200);
  assert.equal(on.body.ok, true);
  assert.deepEqual(on.body.card, { type: 'lights', id: 'demo-home:gym-lights', label: 'Gym lights', status: 'on', simulated: true });
  const off = await post({ request_id: randomUUID(), connector: 'demo-home', device: 'Gym lights', action: 'turn_off' });
  assert.equal(off.body.card.status, 'off');
  assert.equal((await post({ request_id: randomUUID(), device: 'Oven', action: 'preheat' })).status, 400, 'only on and off from a tap');
  const missing = await post({ request_id: randomUUID(), device: 'Garage door', action: 'turn_on' });
  assert.equal(missing.body.ok, false);
  assert.equal(missing.body.card, null);

  await app.memory.store.putRule({ kind: 'tool_deny', value: 'home_control', scope: 'tools', original: 'Never control home devices.', explanation: 'test', source_id: 'manual', source_quote: '' });
  const denied = await post({ request_id: randomUUID(), connector: 'demo-home', device: 'Gym lights', action: 'turn_on' });
  assert.equal(denied.status, 400);
  assert.match(denied.body.error, /home_control|not allowed|block|instruction/i);
});
