import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.js';

// A stand-in Home Assistant speaking the documented REST shapes over a real socket. It proves MERLIN's real HTTP stack,
// headers, redirects policy and end-to-end flow. It does NOT prove that a genuine Home Assistant behaves the same.
const TOKEN = 'integration-token-not-real';
function fakeHomeAssistant() {
  const lamp = { entity_id: 'light.desk', state: 'on', attributes: { friendly_name: 'Desk Lamp', supported_color_modes: ['brightness'], brightness: 255 } };
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: '401: Unauthorized' });
    if (req.url === '/api/') return send(200, { message: 'API running.' });
    if (req.url === '/api/config') return send(200, { location_name: 'Test Home', version: '2026.5.0', unit_system: { temperature: '°C' } });
    if (req.url === '/api/states') return send(200, [lamp]);
    if (req.url === '/api/states/light.desk') return send(200, lamp);
    if (req.method === 'POST' && req.url === '/api/services/light/turn_off') { lamp.state = 'off'; return send(200, [lamp]); }
    return send(404, { message: 'not found' });
  });
  return { server, lamp, requests };
}

const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const closeServer = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });

const call = (name, args, call_id = randomUUID()) => ({ type: 'function_call', status: 'completed', name, arguments: JSON.stringify(args), call_id });
const reply = text => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] });

test('connecting Home Assistant over HTTP proves access, stores the token privately, and controls a device end to end', async t => {
  const ha = fakeHomeAssistant();
  const haPort = await listen(ha.server);
  const directory = await mkdtemp(join(tmpdir(), 'merlin-http-connector-'));
  const steps = [[call('home_control', { device: 'desk lamp', action: 'turn_off' })], [reply('The lamp is off.')]];
  const meta = { configured: true, model: 'synthetic', async respond() { return structuredClone(steps.shift()); } };
  const app = await createApp({ dataDir: directory, meta, learningDelayMs: 60000 });
  t.after(async () => {
    await app.learning.close();
    await closeServer(app.server);
    await closeServer(ha.server);
    await rm(directory, { recursive: true, force: true });
  });
  const port = await listen(app.server);
  const send = (method, path, body) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });

  // 1. Nothing saved: not connected, and no device tools.
  assert.equal((await send('GET', '/api/connectors')).body.connectors.find(item => item.id === 'home-assistant').status, 'not_connected');

  // 2. A wrong token is refused by the real service and nothing is saved.
  const wrong = await send('POST', '/api/connectors/home-assistant/connect', { url: `http://127.0.0.1:${haPort}`, token: 'wrong-token' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body.error, /rejected the saved credentials/);
  assert.doesNotMatch(JSON.stringify(wrong.body), /wrong-token/);
  assert.equal((await send('GET', '/api/connectors')).body.connectors.find(item => item.id === 'home-assistant').status, 'not_connected');

  // 3. The right token is verified against the service, then saved.
  const ok = await send('POST', '/api/connectors/home-assistant/connect', { url: `http://127.0.0.1:${haPort}/`, token: TOKEN });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'connected');
  assert.doesNotMatch(JSON.stringify(ok.body), new RegExp(TOKEN));
  assert.ok(ha.requests.includes('GET /api/') && ha.requests.includes('GET /api/config'), 'MERLIN really contacted the service before saving');
  const file = await readFile(join(directory, 'connectors.json'), 'utf8');
  assert.match(file, new RegExp(TOKEN), 'stored on the server only');
  const everythingElse = JSON.stringify([(await send('GET', '/api/connectors')).body, (await send('GET', '/api/companion/state')).body, (await send('GET', '/api/state')).body]);
  assert.doesNotMatch(everythingElse, new RegExp(TOKEN));

  // 4. The assistant now controls the device, and the receipt reflects the state the service reported.
  const chat = await send('POST', '/api/chat', { message: 'turn off the desk lamp', session_id: randomUUID(), request_id: randomUUID(), time_zone: 'America/New_York' });
  assert.equal(chat.status, 200, JSON.stringify(chat.body));
  assert.equal(ha.lamp.state, 'off');
  assert.match(chat.body.reply, /Turned off Desk Lamp\. Home Assistant reports it\./);

  // 5. Verify, then disconnect: the credentials are gone and the tools with them.
  assert.equal((await send('POST', '/api/connectors/home-assistant/verify', {})).body.status, 'connected');
  const gone = await send('POST', '/api/connectors/home-assistant/disconnect', {});
  assert.equal(gone.body.status, 'not_connected');
  assert.match(gone.body.message, /delete the MERLIN token/i);
  assert.doesNotMatch(await readFile(join(directory, 'connectors.json'), 'utf8'), new RegExp(TOKEN));
});

test('an unreachable address is reported honestly and saves nothing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-http-connector-'));
  const app = await createApp({ dataDir: directory, meta: { configured: true, model: 'synthetic' }, learningDelayMs: 60000 });
  t.after(async () => { await app.learning.close(); await closeServer(app.server); await rm(directory, { recursive: true, force: true }); });
  const port = await listen(app.server);
  const dead = createServer(); const deadPort = await listen(dead); await closeServer(dead);
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/api/connectors/home-assistant/connect', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ url: `http://127.0.0.1:${deadPort}`, token: TOKEN }));
  });
  assert.equal(response.status, 502);
  assert.match(response.body.error, /could not be reached/);
  assert.equal(app.connections?.get?.('home-assistant')?.status ?? 'not_connected', 'not_connected');
});

test('MERLIN serves the Connection Center in live mode, with every asset it imports, and redirects the bare path', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-http-connector-'));
  const app = await createApp({ dataDir: directory, meta: { configured: true, model: 'synthetic' }, learningDelayMs: 60000 });
  t.after(async () => { await app.learning.close(); await closeServer(app.server); await rm(directory, { recursive: true, force: true }); });
  const port = await listen(app.server);
  const raw = path => new Promise((resolve, reject) => {
    httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject).end();
  });
  const page = await raw('/connections/');
  assert.equal(page.status, 200);
  assert.match(page.text, /<html lang="en" data-live="true">/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.doesNotMatch(page.headers['content-security-policy'], /unsafe-inline/);
  for (const asset of ['app.js', 'live.js', 'catalog.js', 'integrations.js', 'icons.js', 'styles.css']) assert.equal((await raw(`/connections/${asset}`)).status, 200, asset);
  assert.equal((await raw('/connections/state.js')).status, 404, 'the old demo storage module is gone');
  assert.equal((await raw('/connections/../memory.js')).status === 200, false);
  const bare = await raw('/connections');
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.location, '/connections/');
});
