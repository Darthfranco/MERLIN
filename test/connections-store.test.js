import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectionStore } from '../src/connections.js';
import { connectedCategories } from '../src/connection-intents.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-connections-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, 'connections.json') };
}

test('preview connections persist only catalog IDs with owner-only permissions', async t => {
  const { file } = await fixture(t);
  const store = await new ConnectionStore({ filePath: file, now: () => '2026-10-31T12:00:00.000Z' }).init();
  assert.deepEqual(store.list(), []);
  assert.deepEqual(await store.connect('philips-hue'), { id: 'philips-hue', connected_at: '2026-10-31T12:00:00.000Z' });
  assert.deepEqual(await store.connect('philips-hue'), { id: 'philips-hue', connected_at: '2026-10-31T12:00:00.000Z' }, 'connecting twice is harmless');
  await store.connect('ring');
  assert.deepEqual(store.ids(), ['philips-hue', 'ring']);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(saved), ['version', 'connections']);
  assert.deepEqual(Object.keys(saved.connections[0]).sort(), ['connected_at', 'id']);
  const reloaded = await new ConnectionStore({ filePath: file }).init();
  assert.deepEqual(reloaded.ids(), ['philips-hue', 'ring']);
  assert.equal(await reloaded.disconnect('ring'), true);
  assert.equal(await reloaded.disconnect('ring'), false);
  assert.deepEqual(reloaded.ids(), ['philips-hue']);
  await reloaded.clear();
  assert.deepEqual(reloaded.list(), []);
});

test('unknown, malformed, and restricted routes are refused without changing the file', async t => {
  const { file } = await fixture(t);
  const store = await new ConnectionStore({ filePath: file }).init();
  for (const id of ['nope', '', null, undefined, 42, {}, '__proto__']) await assert.rejects(store.connect(id), /Choose a connection/);
  await assert.rejects(store.disconnect('nope'), /Choose a connection/);
  await assert.rejects(store.connect('myq'), error => error.status === 409 && /no supported route/.test(error.message));
  assert.deepEqual(store.list(), []);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('stored data is validated on load and never trusted', async t => {
  const { file } = await fixture(t);
  await writeFile(file, JSON.stringify({ version: 1, connections: [
    { id: 'ring', connected_at: '2026-10-31T12:00:00.000Z' }, { id: 'ring', connected_at: '2026-10-31T13:00:00.000Z' },
    { id: 'myq', connected_at: '2026-10-31T12:00:00.000Z' }, { id: 'ghost', connected_at: '2026-10-31T12:00:00.000Z' },
    { id: 'sonos', connected_at: 'not a date' }, { id: 'sonos', connected_at: '2026-10-31T12:00:00.000Z', token: 'secret' }, 'junk',
  ] }));
  const store = await new ConnectionStore({ filePath: file }).init();
  assert.deepEqual(store.list(), [{ id: 'ring', connected_at: '2026-10-31T12:00:00.000Z' }, { id: 'sonos', connected_at: '2026-10-31T12:00:00.000Z' }]);
  await writeFile(file, '{broken');
  await assert.rejects(new ConnectionStore({ filePath: file }).init(), /not valid JSON/);
  await writeFile(file, JSON.stringify({ version: 2, connections: [] }));
  await assert.rejects(new ConnectionStore({ filePath: file }).init(), /unsupported format/);
});

test('concurrent changes are serialized and a failed save leaves state unchanged', async t => {
  const { directory, file } = await fixture(t);
  const store = await new ConnectionStore({ filePath: file }).init();
  await Promise.all(['ring', 'sonos', 'ecobee', 'ring'].map(id => store.connect(id)));
  assert.deepEqual(store.ids().sort(), ['ecobee', 'ring', 'sonos']);
  const blocked = await new ConnectionStore({ filePath: join(directory, 'blocked', 'connections.json') }).init();
  await writeFile(join(directory, 'blocked'), 'a file where the data folder should be');
  await assert.rejects(blocked.connect('ring'), /Could not save/);
  assert.deepEqual(blocked.list(), []);
});

test('connected categories come from the catalog', () => {
  assert.deepEqual([...connectedCategories(['philips-hue'])].sort(), ['lights', 'sensors']);
  assert.equal(connectedCategories([]).size, 0);
  assert.equal(connectedCategories(['ghost']).size, 0);
});
