import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeConnections, readConnections, writeConnections, STORAGE_KEY } from '../public/connections/state.js';

test('demo persistence restores only known IDs and removes duplicates', () => {
  const restored = decodeConnections(JSON.stringify({ version: 1, ids: ['hue', 'hue', 'unknown', null, 'shelly'] }), ['hue', 'shelly']);
  assert.deepEqual([...restored], ['hue', 'shelly']);
});

test('demo storage excludes unknown values and stores no user credentials or configuration', () => {
  let stored;
  const storage = { setItem(key, value) { assert.equal(key, STORAGE_KEY); stored = value; } };
  assert.equal(writeConnections(storage, new Set(['hue', 'unrecognized']), ['hue']), null);
  assert.deepEqual(JSON.parse(stored), { version: 1, ids: ['hue'] });
});

test('corrupt or unavailable storage leaves a usable empty session with feedback', () => {
  for (const storage of [null, { getItem() { throw new Error('blocked'); } }, { getItem() { return '{bad'; } }, { getItem() { return '{"version":2,"ids":[]}'; } }]) {
    const result = readConnections(storage, ['hue']);
    assert.equal(result.ids.size, 0);
    assert.ok(result.error);
  }
  assert.ok(writeConnections(null, new Set(['hue']), ['hue']));
});

test('clear roundtrip produces an empty valid record without restoring previous connections', () => {
  let data = JSON.stringify({ version: 1, ids: ['hue'] });
  const storage = { setItem(key, value) { data = value; }, getItem() { return data; } };
  assert.equal(readConnections(storage, ['hue']).ids.size, 1);
  writeConnections(storage, new Set(), ['hue']);
  assert.equal(readConnections(storage, ['hue']).ids.size, 0);
});
