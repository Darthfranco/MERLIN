import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createConnectionsServer } from '../src/connections-server.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'merlin-connections-'));
  const publicRoot = join(directory, 'public');
  await mkdir(publicRoot);
  const assets = {
    'index.html': '<!doctype html><title>MERLIN Connection Center demo</title>',
    'app.js': 'export const demo = true;',
    'catalog.js': 'export const catalog = [];',
    'icons.js': 'export const icons = {};',
    'state.js': 'export const state = {};',
    'styles.css': 'body { color: navy; }',
  };
  await Promise.all(Object.entries(assets).map(([name, content]) => writeFile(join(publicRoot, name), content)));
  await writeFile(join(directory, '.env'), 'SYNTHETIC_PRIVATE_FILE=not-public');
  await writeFile(join(publicRoot, 'unexpected.json'), '{"syntheticPrivate":true}');
  const server = createConnectionsServer({ publicRoot });
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
  return { server, publicRoot, directory, port, assets, request };
}

test('connection demo serves only its explicit asset files with correct content types', async t => {
  const app = await fixture(t);
  assert.equal(app.server.address().address, '127.0.0.1');
  for (const [name, content] of Object.entries(app.assets)) {
    const response = await app.request(`/${name}?v=demo`);
    assert.equal(response.status, 200, name);
    assert.equal(response.text, content);
    assert.equal(Number(response.headers['content-length']), Buffer.byteLength(content));
    const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html';
    assert.equal(response.headers['content-type'], `${type}; charset=utf-8`);
  }
  assert.equal((await app.request('/')).text, app.assets['index.html']);
  assert.equal((await app.request('/%61pp.js')).text, app.assets['app.js']);
});

test('connection demo health and every response carry restrictive browser headers', async t => {
  const app = await fixture(t);
  const health = await app.request('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.text), { ok: true, mode: 'demo' });
  for (const response of [health, await app.request('/'), await app.request('/missing')]) {
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()');
    const csp = response.headers['content-security-policy'];
    for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'none'", "img-src 'self' data:", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"]) {
      assert.ok(csp.split('; ').includes(directive), directive);
    }
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
});

test('HEAD returns GET metadata without response bodies, including errors', async t => {
  const app = await fixture(t);
  for (const path of ['/', '/styles.css', '/health', '/missing', '/%']) {
    const get = await app.request(path);
    const head = await app.request(path, { method: 'HEAD' });
    assert.equal(head.status, get.status, path);
    assert.equal(head.text, '');
    assert.equal(head.headers['content-type'], get.headers['content-type']);
    assert.equal(head.headers['content-length'], get.headers['content-length']);
  }
});

test('methods other than GET and HEAD cannot submit data or execute actions', async t => {
  const app = await fixture(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
    for (const path of ['/', '/health', '/api/connect']) {
      const response = await app.request(path, { method });
      assert.equal(response.status, 405, `${method} ${path}`);
      assert.equal(response.headers.allow, 'GET, HEAD');
    }
  }
});

test('local host and same-origin checks reject DNS rebinding and cross-site access', async t => {
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
    const response = await app.request('/health', { headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.doesNotMatch(response.text, /mode/);
  }
});

test('cross-site document links open the demo without enabling cross-site fetches or other routes', async t => {
  const app = await fixture(t);
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  for (const method of ['GET', 'HEAD']) {
    for (const path of ['/', '/index.html', '/?from=link', '/index.html?from=link']) {
      const response = await app.request(path, { method, headers: navigation });
      assert.equal(response.status, 200, `${method} ${path}`);
      assert.equal(response.text, method === 'HEAD' ? '' : app.assets['index.html']);
    }
  }
  for (const path of ['/health', '/app.js', '/styles.css', '/missing']) {
    assert.equal((await app.request(path, { headers: navigation })).status, 403, path);
  }
  for (const headers of [
    { ...navigation, Origin: 'https://attacker.example' },
    { ...navigation, Origin: 'null' },
    { ...navigation, Host: `attacker.example:${app.port}` },
    { ...navigation, 'Sec-Fetch-Mode': 'cors' },
    { ...navigation, 'Sec-Fetch-Dest': 'iframe' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    assert.equal((await app.request('/', { headers })).status, 403, JSON.stringify(headers));
  }
  assert.equal((await app.request('/', { method: 'POST', headers: navigation })).status, 403);
});

test('private files, traversal paths, other application routes and proxy targets are unavailable', async t => {
  const app = await fixture(t);
  for (const path of [
    '/.env', '/../.env', '/%2e%2e/.env', '/%2e%2e%2f.env', '/%252e%252e%252f.env',
    '/public/../index.html', '/public/%2e%2e/index.html', '/unexpected.json',
    '/src/server.js', '/package.json', '/api/chat', '/api/state', '/api/memory',
    '/api/spotify/status', '/api/voice/status', '/proxy?url=https://example.com',
  ]) {
    const response = await app.request(path);
    assert.equal(response.status, 404, path);
    assert.deepEqual(JSON.parse(response.text), { error: 'Not found.' });
  }
  for (const path of ['/%', '/%FF', '/%00', '/%5c..%5c.env', '//example.com/health', 'http://example.com/health', '/health#fragment']) {
    assert.equal((await app.request(path)).status, 400, path);
  }
  assert.equal((await app.request('/health')).status, 200);
});

test('missing assets, directories and symlinks cannot disclose files outside the public asset set', async t => {
  const app = await fixture(t);
  await rm(join(app.publicRoot, 'icons.js'));
  assert.equal((await app.request('/icons.js')).status, 404);
  await symlink(join(app.directory, '.env'), join(app.publicRoot, 'icons.js'));
  const symlinkResponse = await app.request('/icons.js');
  assert.equal(symlinkResponse.status, 404);
  assert.doesNotMatch(symlinkResponse.text, /SYNTHETIC_PRIVATE_FILE/);
  await rm(join(app.publicRoot, 'styles.css'));
  await mkdir(join(app.publicRoot, 'styles.css'));
  assert.equal((await app.request('/styles.css')).status, 404);
});
