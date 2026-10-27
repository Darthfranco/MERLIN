import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, CONNECTIONS, searchConnections } from '../public/connections/catalog.js';

const ids = (entries) => entries.map(({ id }) => id);

test('catalog has unique stable IDs, valid categories and complete setup references', () => {
  assert.ok(CONNECTIONS.length >= 40);
  assert.equal(new Set(ids(CONNECTIONS)).size, CONNECTIONS.length);
  assert.equal(new Set(ids(CATEGORIES)).size, CATEGORIES.length);
  const categories = new Set(ids(CATEGORIES));
  const icons = new Set(['light', 'plug', 'camera', 'speaker', 'climate', 'appliance', 'sensor', 'lock', 'blinds', 'vacuum', 'tv', 'garden', 'energy', 'garage', 'hub']);
  for (const category of CATEGORIES) {
    assert.ok(category.label.trim());
    assert.ok(icons.has(category.icon));
  }
  for (const entry of CONNECTIONS) {
    assert.match(entry.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    for (const field of ['name', 'company', 'description', 'difficultyReason', 'method']) {
      assert.ok(typeof entry[field] === 'string' && entry[field].trim(), `${entry.id}.${field}`);
    }
    assert.ok(['easy', 'medium', 'hard'].includes(entry.difficulty));
    assert.ok(['standard', 'advanced', 'restricted'].includes(entry.availability));
    assert.ok(Array.isArray(entry.aliases) && entry.aliases.every((alias) => typeof alias === 'string'));
    assert.ok(entry.categoryIds.length > 0 && entry.categoryIds.every((id) => categories.has(id)));
    assert.equal(new Set(entry.categoryIds).size, entry.categoryIds.length);
    assert.ok(entry.requirements.length && entry.requirements.every((item) => typeof item === 'string' && item.trim()));
    assert.ok(entry.limitations.length && entry.limitations.every((item) => typeof item === 'string' && item.trim()));
    assert.ok(entry.steps.length >= 2 && entry.steps.every(({ title, body }) => title?.trim() && body?.trim()));
    const guide = new URL(entry.guideUrl);
    assert.equal(guide.protocol, 'https:');
    assert.equal(guide.username, '');
    assert.equal(guide.password, '');
    assert.equal(guide.search, '');
    if (entry.availability === 'restricted') assert.ok(entry.availabilityNote?.trim());
  }
});

test('default and whitespace searches return the complete catalog in display order', () => {
  assert.deepEqual(ids(searchConnections()), ids(CONNECTIONS));
  assert.deepEqual(ids(searchConnections({ query: '  \n\t ' })), ids(CONNECTIONS));
  assert.notEqual(searchConnections(), CONNECTIONS);
});

test('search is case and accent insensitive across company, product and aliases', () => {
  assert.deepEqual(ids(searchConnections({ query: 'CaFÉ MONOGRAM' })), ['smarthq']);
  assert.deepEqual(ids(searchConnections({ query: 'lutron caseta' })), ['lutron']);
  assert.deepEqual(ids(searchConnections({ query: 'TRADFRI' })), ['ikea']);
  assert.deepEqual(ids(searchConnections({ query: 'TÁPO KASA' })), ['tapo-kasa']);
});

test('multiword queries require every token and can span fields', () => {
  assert.deepEqual(ids(searchConnections({ query: 'lg washer' })), ['lg-thinq']);
  assert.deepEqual(ids(searchConnections({ query: 'philips sensors' })), ['philips-hue']);
  assert.deepEqual(ids(searchConnections({ query: 'shelly installed' })), ['shelly']);
  assert.deepEqual(searchConnections({ query: 'Hue Roomba' }), []);
});

test('punctuation and repeated whitespace do not break useful brand queries', () => {
  assert.deepEqual(ids(searchConnections({ query: 'TP-Link   Kasa' })), ['tapo-kasa']);
  assert.deepEqual(ids(searchConnections({ query: 'smart-hq' })), ['smarthq']);
  assert.deepEqual(searchConnections({ query: 'zz-nonexistent-device' }), []);
});

test('category, company and difficulty filters compose with search', () => {
  assert.deepEqual(ids(searchConnections({ company: 'lg', category: 'tvs' })), ['lg-webos']);
  assert.deepEqual(ids(searchConnections({ company: 'LG', difficulty: 'hard' })), ['lg-thinq']);
  assert.deepEqual(ids(searchConnections({ category: 'locks', query: 'Encode' })), ['schlage']);
  assert.deepEqual(ids(searchConnections({ company: 'LÚTRON', category: 'blinds', difficulty: 'medium' })), ['lutron']);
  assert.deepEqual(searchConnections({ category: 'does-not-exist' }), []);
  assert.deepEqual(searchConnections({ company: 'not-a-company' }), []);
});

test('connected filtering supports arrays and sets without conflating vendor availability', () => {
  const connected = ['philips-hue', 'sonos', 'not-in-catalog'];
  assert.deepEqual(ids(searchConnections({ connectedIds: connected, view: 'connected' })), ['philips-hue', 'sonos']);
  assert.deepEqual(ids(searchConnections({ connectedIds: new Set(connected), view: 'connected', category: 'speakers' })), ['sonos']);
  assert.ok(!ids(searchConnections({ connectedIds: connected, view: 'available' })).includes('sonos'));
  assert.ok(ids(searchConnections({ connectedIds: connected, view: 'available' })).includes('myq'));
  assert.deepEqual(searchConnections({ view: 'connected' }), []);
  assert.deepEqual(ids(searchConnections({ view: 'available' })), ids(CONNECTIONS));
  assert.deepEqual(ids(searchConnections({ connectedIds: connected, view: 'unconnected' })), ids(searchConnections({ connectedIds: connected, view: 'available' })));
});

test('filtering does not mutate catalog entries, caller options or connection collections', () => {
  const before = JSON.stringify({ CATEGORIES, CONNECTIONS });
  const connectedIds = new Set(['sonos']);
  const options = Object.freeze({ query: 'speaker', category: 'speakers', connectedIds, view: 'connected' });
  const result = searchConnections(options);
  result.reverse();
  result.pop();
  assert.equal(JSON.stringify({ CATEGORIES, CONNECTIONS }), before);
  assert.deepEqual([...connectedIds], ['sonos']);
  assert.equal(options.query, 'speaker');
});

test('restricted and technical routes preserve the important prerequisites', () => {
  const byId = new Map(CONNECTIONS.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('myq').availability, 'restricted');
  assert.match(byId.get('myq').availabilityNote, /unavailable/i);
  assert.equal(byId.get('google-home-mcp').availability, 'restricted');
  assert.ok(byId.get('matter').requirements.some((text) => /Thread border router/.test(text)));
  assert.ok(byId.get('home-assistant').difficultyReason.includes('existing'));
  for (const entry of CONNECTIONS.filter((item) => item.id !== 'home-assistant' && item.method.startsWith('Home Assistant'))) {
    assert.ok(entry.requirements.some((text) => /Home Assistant running at home/.test(text)), entry.id);
  }
});
