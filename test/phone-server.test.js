import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createPhoneServer } from '../src/phone-server.js';

const IMPORT_MAP = '{"imports":{"three":"/character/viewer/vendor/three/build/three.module.min.js","three/addons/":"/character/viewer/vendor/three/examples/jsm/"}}';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-phone-'));
  const publicRoot = join(directory, 'public/phone');
  const characterRoot = join(directory, 'character');
  const catalogPath = join(directory, 'public/connections/catalog.js');
  const spokenTextPath = join(directory, 'public/shared/spoken-text.js');
  const phoneAssets = {
    'index.html': `<!doctype html><title>MERLIN phone</title><script type="importmap">${IMPORT_MAP}</script>`,
    'app.js': 'export const demo = true;',
    'styles.css': 'body { color: navy; }',
    'logos/spotify.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    'icons/app.png': 'synthetic image',
    'fonts/interface.woff2': 'synthetic font',
    'fonts/interface.ttf': 'synthetic font',
    'manifest.webmanifest': '{"name":"MERLIN"}',
  };
  const faceAssets = {
    'merlin-states.glb': 'synthetic model',
    'states.json': '{"camera":{}}',
    'previews/merlin-fullscreen-face.png': 'synthetic face',
    'viewer/vendor/three/build/three.module.min.js': 'export const renderer = {};',
    'viewer/vendor/three/build/three.core.min.js': 'export const core = {};',
    'viewer/vendor/three/examples/jsm/loaders/GLTFLoader.js': 'export class GLTFLoader {}',
    'viewer/vendor/three/examples/jsm/utils/BufferGeometryUtils.js': 'export const convert = () => {};',
  };
  for (const [root, assets] of [[publicRoot, phoneAssets], [characterRoot, faceAssets]]) {
    for (const [name, content] of Object.entries(assets)) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), content);
    }
  }
  await mkdir(dirname(catalogPath), { recursive: true });
  await writeFile(catalogPath, 'export const catalog = [];');
  await mkdir(dirname(spokenTextPath), { recursive: true });
  await writeFile(spokenTextPath, 'export const normalizeSpokenText = text => text;');
  await writeFile(join(dirname(spokenTextPath), 'private.js'), 'not an allowed shared asset');
  await writeFile(join(directory, '.env'), 'SYNTHETIC_PRIVATE_FILE=not-public');
  await writeFile(join(publicRoot, 'private.json'), '{"private":true}');
  await writeFile(join(characterRoot, 'merlin-states.blend'), 'not a public phone asset');
  const server = createPhoneServer({ publicRoot, characterRoot, catalogPath, spokenTextPath });
  assert.equal(server.listening, false);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    await rm(directory, { recursive: true, force: true });
  });
  const port = server.address().port;
  const request = (path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
  return { server, publicRoot, characterRoot, catalogPath, spokenTextPath, directory, port, phoneAssets, faceAssets, request };
}

test('phone demo serves its own nested assets, existing catalog, and only the required character assets', async t => {
  const app = await fixture(t);
  assert.equal(app.server.address().address, '127.0.0.1');
  for (const [prefix, assets] of [['/phone/', app.phoneAssets], ['/character/', app.faceAssets]]) {
    for (const [name, content] of Object.entries(assets)) {
      const response = await app.request(`${prefix}${name}?v=demo`);
      assert.equal(response.status, 200, name);
      assert.equal(response.text, content);
      assert.equal(Number(response.headers['content-length']), Buffer.byteLength(content));
    }
  }
  for (const path of ['/', '/index.html', '/phone', '/phone/', '/phone/index.html']) {
    assert.equal((await app.request(path)).text, app.phoneAssets['index.html'], path);
  }
  assert.equal((await app.request('/phone/%61pp.js')).text, app.phoneAssets['app.js']);
  assert.equal((await app.request('/connections/catalog.js')).text, 'export const catalog = [];');
  assert.equal((await app.request('/shared/spoken-text.js')).text, 'export const normalizeSpokenText = text => text;');
  const expectedTypes = {
    '/': 'text/html; charset=utf-8', '/phone/app.js': 'text/javascript; charset=utf-8',
    '/phone/styles.css': 'text/css; charset=utf-8', '/phone/logos/spotify.svg': 'image/svg+xml',
    '/phone/icons/app.png': 'image/png', '/phone/fonts/interface.woff2': 'font/woff2',
    '/phone/fonts/interface.ttf': 'font/ttf', '/phone/manifest.webmanifest': 'application/manifest+json',
    '/character/states.json': 'application/json; charset=utf-8', '/character/merlin-states.glb': 'model/gltf-binary',
    '/shared/spoken-text.js': 'text/javascript; charset=utf-8',
  };
  for (const [path, type] of Object.entries(expectedTypes)) assert.equal((await app.request(path)).headers['content-type'], type, path);
});

test('browser policy allows only local demo assets, the exact import map, and explicit local microphone use', async t => {
  const app = await fixture(t);
  const health = await app.request('/health');
  assert.deepEqual(JSON.parse(health.text), { ok: true, mode: 'demo', surface: 'phone' });
  const mapHash = createHash('sha256').update(IMPORT_MAP).digest('base64');
  for (const response of [health, await app.request('/'), await app.request('/missing')]) {
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['permissions-policy'], 'camera=(), microphone=(self), geolocation=(), on-device-speech-recognition=(self)');
    const csp = response.headers['content-security-policy'];
    for (const directive of ["default-src 'none'", `script-src 'self' 'sha256-${mapHash}'`, "style-src 'self'", "connect-src 'self' blob:", "img-src 'self' data: blob:", "media-src 'self' blob:", "frame-ancestors 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
      assert.ok(csp.split('; ').includes(directive), directive);
    }
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
});

test('HEAD returns asset and error metadata without reading out bodies', async t => {
  const app = await fixture(t);
  for (const path of ['/', '/phone/styles.css', '/shared/spoken-text.js', '/character/merlin-states.glb', '/health', '/missing', '/%']) {
    const get = await app.request(path);
    const head = await app.request(path, { method: 'HEAD' });
    assert.equal(head.status, get.status, path);
    assert.equal(head.text, '');
    assert.equal(head.headers['content-type'], get.headers['content-type']);
    assert.equal(head.headers['content-length'], get.headers['content-length']);
  }
});

test('server exposes no mutation, upload, model, connection, or credential APIs', async t => {
  const app = await fixture(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
    for (const path of ['/', '/health', '/api/chat', '/api/upload', '/api/connect']) {
      const response = await app.request(path, { method });
      assert.equal(response.status, 405, `${method} ${path}`);
      assert.equal(response.headers.allow, 'GET, HEAD');
    }
  }
  for (const path of ['/api/chat', '/api/state', '/api/memory', '/api/upload', '/api/spotify/status', '/api/voice/status', '/api/spotify/callback', '/proxy?url=https://example.com', '/voice/', '/companion/']) {
    assert.equal((await app.request(path)).status, 404, path);
  }
});

test('local Host and same-origin checks prevent rebinding and cross-site access', async t => {
  const app = await fixture(t);
  for (const host of [`127.0.0.1:${app.port}`, `localhost:${app.port}`]) {
    assert.equal((await app.request('/health', { headers: { Host: host, Origin: `http://${host}` } })).status, 200);
  }
  for (const headers of [
    { Host: `attacker.example:${app.port}` }, { Host: 'localhost' },
    { Host: `localhost:${app.port + 1}` }, { Host: `127.0.0.1.attacker.example:${app.port}` },
    { Origin: 'https://attacker.example' }, { Origin: 'null' },
    { Origin: `http://localhost:${app.port}` }, { Origin: `https://127.0.0.1:${app.port}` },
    { 'Sec-Fetch-Site': 'cross-site' },
    ['Host', `127.0.0.1:${app.port}`, 'Host', `attacker.example:${app.port}`],
  ]) {
    assert.equal((await app.request('/health', { headers })).status, 403, JSON.stringify(headers));
  }
});

test('top-level incoming links can open the demo without enabling cross-site asset fetches', async t => {
  const app = await fixture(t);
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  for (const method of ['GET', 'HEAD']) {
    for (const path of ['/', '/phone/', '/phone/index.html', '/?from=link', '/phone?from=link']) {
      assert.equal((await app.request(path, { method, headers: navigation })).status, 200, `${method} ${path}`);
    }
  }
  for (const path of ['/health', '/phone/app.js', '/connections/catalog.js', '/character/merlin-states.glb', '/missing']) {
    assert.equal((await app.request(path, { headers: navigation })).status, 403, path);
  }
  for (const headers of [
    { ...navigation, Origin: 'https://attacker.example' },
    { ...navigation, 'Sec-Fetch-Mode': 'cors' }, { ...navigation, 'Sec-Fetch-Dest': 'iframe' },
  ]) assert.equal((await app.request('/', { headers })).status, 403, JSON.stringify(headers));
});

test('private files, unexpected character assets, traversal, and malformed paths stay unavailable', async t => {
  const app = await fixture(t);
  for (const path of [
    '/.env', '/../.env', '/%2e%2e/.env', '/phone/../connections/catalog.js',
    '/phone/%2e%2e/connections/catalog.js', '/phone/%2e%2e%2f.env', '/phone/%252e%252e%252f.env',
    '/phone/private.json', '/phone/.hidden.js', '/phone/logos/../app.js', '/phone//app.js',
    '/src/server.js', '/package.json', '/connections/app.js',
    '/shared/private.js', '/shared/', '/shared/../phone/app.js', '/shared/%2e%2e/.env',
    '/character/merlin-states.blend', '/character/merlin.glb', '/character/viewer/character.js',
    '/character/viewer/vendor/three/NOTICE.md', '/character/../phone/index.html',
  ]) {
    const response = await app.request(path);
    assert.equal(response.status, 404, path);
    assert.deepEqual(JSON.parse(response.text), { error: 'Not found.' });
  }
  for (const path of ['/%', '/%FF', '/%00', '/phone/%5c..%5c.env', '//example.com/health', 'http://example.com/health', '/health#fragment']) {
    assert.equal((await app.request(path)).status, 400, path);
  }
  assert.equal((await app.request('/health')).status, 200);
});

test('file and nested-directory symlinks cannot escape any public asset root', async t => {
  const app = await fixture(t);
  await rm(join(app.publicRoot, 'app.js'));
  await symlink(join(app.directory, '.env'), join(app.publicRoot, 'app.js'));
  assert.equal((await app.request('/phone/app.js')).status, 404);
  await rm(join(app.publicRoot, 'logos'), { recursive: true });
  const outside = join(app.directory, 'private');
  await mkdir(outside);
  await writeFile(join(outside, 'spotify.svg'), 'SYNTHETIC_PRIVATE_LOGO');
  await symlink(outside, join(app.publicRoot, 'logos'));
  assert.equal((await app.request('/phone/logos/spotify.svg')).status, 404);
  await rm(join(app.characterRoot, 'previews'), { recursive: true });
  await writeFile(join(outside, 'merlin-fullscreen-face.png'), 'SYNTHETIC_PRIVATE_IMAGE');
  await symlink(outside, join(app.characterRoot, 'previews'));
  assert.equal((await app.request('/character/previews/merlin-fullscreen-face.png')).status, 404);
  await rm(app.catalogPath);
  await symlink(join(app.directory, '.env'), app.catalogPath);
  assert.equal((await app.request('/connections/catalog.js')).status, 404);
  await rm(app.spokenTextPath);
  await symlink(join(app.directory, '.env'), app.spokenTextPath);
  assert.equal((await app.request('/shared/spoken-text.js')).status, 404);
  await rm(join(app.publicRoot, 'styles.css'));
  await mkdir(join(app.publicRoot, 'styles.css'));
  assert.equal((await app.request('/phone/styles.css')).status, 404);
});

test('the real entry document import map stays synchronized with the restrictive CSP', async t => {
  let html;
  try {
    html = await readFile(new URL('../public/phone/index.html', import.meta.url), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return t.skip('phone interface is not present in this checkout');
    throw error;
  }
  const map = html.match(/<script\s+type="importmap">([\s\S]*?)<\/script>/)?.[1];
  assert.equal(map, IMPORT_MAP, 'Changes to import map whitespace/content require the matching CSP hash.');
});
