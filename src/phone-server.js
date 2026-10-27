import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_ROOT = join(PROJECT_ROOT, 'public/phone');
const CHARACTER_ROOT = join(PROJECT_ROOT, 'assets/merlin-character');
const CATALOG_PATH = join(PROJECT_ROOT, 'public/connections/catalog.js');
const IMPORT_MAP = '{"imports":{"three":"/character/viewer/vendor/three/build/three.module.min.js","three/addons/":"/character/viewer/vendor/three/examples/jsm/"}}';
const IMPORT_MAP_HASH = createHash('sha256').update(IMPORT_MAP).digest('base64');
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'], ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'],
  ['.webmanifest', 'application/manifest+json'],
]);
const CHARACTER_FILES = new Map([
  ['merlin-states.glb', 'model/gltf-binary'],
  ['states.json', 'application/json; charset=utf-8'],
  ['previews/merlin-fullscreen-face.png', 'image/png'],
  ...[
    'build/three.module.min.js', 'build/three.core.min.js',
    'examples/jsm/loaders/GLTFLoader.js', 'examples/jsm/utils/BufferGeometryUtils.js',
  ].map(name => [`viewer/vendor/three/${name}`, 'text/javascript; charset=utf-8']),
]);
const DOCUMENT_PATHS = new Set(['/', '/index.html', '/phone', '/phone/', '/phone/index.html']);
const CSP = `default-src 'none'; script-src 'self' 'sha256-${IMPORT_MAP_HASH}'; style-src 'self'; font-src 'self'; connect-src 'self' blob:; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;

function respond(req, res, status, type, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function json(req, res, status, value) {
  respond(req, res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function missingFile() {
  return Object.assign(new Error('Not found.'), { code: 'ENOENT' });
}

// O_NOFOLLOW protects the final file; checking every ancestor also rejects a
// nested logo/vendor directory that has been replaced with a symlink.
async function openPublicFile(root, filename) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw missingFile();
  const parts = filename.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) throw missingFile();
  }
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(current)]);
  if (!canonicalFile.startsWith(`${canonicalRoot}${sep}`)) throw missingFile();
  const file = await open(canonicalFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  if (!(await file.stat()).isFile()) {
    await file.close();
    throw missingFile();
  }
  return file;
}

// This isolated demo imports no assistant/provider modules and never loads .env.
// Returning an unstarted server makes tests/imports side-effect free.
export function createPhoneServer({ publicRoot = PUBLIC_ROOT, characterRoot = CHARACTER_ROOT, catalogPath = CATALOG_PATH } = {}) {
  const phoneRoot = resolve(publicRoot);
  const faceRoot = resolve(characterRoot);
  const catalogFile = resolve(catalogPath);
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), on-device-speech-recognition=(self)');
    res.setHeader('Content-Security-Policy', CSP);

    const port = server.address()?.port;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)
      || req.headersDistinct.host?.length !== 1) {
      json(req, res, 403, { error: 'Only local access is allowed.' });
      return;
    }
    const documentNavigation = ['GET', 'HEAD'].includes(req.method)
      && req.headers['sec-fetch-mode'] === 'navigate'
      && req.headers['sec-fetch-dest'] === 'document'
      && DOCUMENT_PATHS.has(req.url?.split('?')[0]);
    if ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
      || (req.headers['sec-fetch-site'] === 'cross-site' && !documentNavigation)) {
      json(req, res, 403, { error: 'Cross-origin requests are not allowed.' });
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      json(req, res, 405, { error: 'Only GET and HEAD are supported.' });
      return;
    }

    // Decode before any URL normalization so traversal attempts stay visible.
    let pathname;
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('#')) throw new Error();
      pathname = decodeURIComponent(req.url.split('?')[0]);
      if (/[\u0000-\u001f\u007f\\]/.test(pathname)) throw new Error();
    } catch {
      json(req, res, 400, { error: 'Invalid request path.' });
      return;
    }
    if (pathname === '/health') {
      json(req, res, 200, { ok: true, mode: 'demo', surface: 'phone' });
      return;
    }

    let root, filename, type;
    if (DOCUMENT_PATHS.has(pathname)) {
      root = phoneRoot;
      filename = 'index.html';
      type = CONTENT_TYPES.get('.html');
    } else if (pathname === '/connections/catalog.js') {
      root = dirname(catalogFile);
      filename = catalogFile.slice(root.length + 1);
      type = CONTENT_TYPES.get('.js');
    } else if (pathname.startsWith('/phone/')) {
      const relative = pathname.slice('/phone/'.length);
      if (relative.split('/').every(part => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))) {
        root = phoneRoot;
        filename = relative;
        type = CONTENT_TYPES.get(extname(relative));
      }
    } else if (pathname.startsWith('/character/')) {
      const relative = pathname.slice('/character/'.length);
      if (CHARACTER_FILES.has(relative)) {
        root = faceRoot;
        filename = relative;
        type = CHARACTER_FILES.get(relative);
      }
    }
    if (!root || !filename || !type) {
      json(req, res, 404, { error: 'Not found.' });
      return;
    }

    let file;
    try {
      file = await openPublicFile(root, filename);
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': (await file.stat()).size });
        res.end();
      } else {
        respond(req, res, 200, type, await file.readFile());
      }
    } catch (error) {
      const missing = ['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP'].includes(error.code);
      json(req, res, missing ? 404 : 500, { error: missing ? 'Not found.' : 'The phone demo could not load this file.' });
    } finally {
      await file?.close();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PHONE_PORT || 3003);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PHONE_PORT must be a valid port.');
  const server = createPhoneServer();
  server.once('error', error => {
    console.error(error.code === 'EADDRINUSE'
      ? `Phone demo port ${port} is in use. Set PHONE_PORT to another port.`
      : 'The phone demo could not start.');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`MERLIN Phone Companion (local demo): http://127.0.0.1:${port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close(error => { if (error) process.exitCode = 1; });
      server.closeAllConnections();
    });
  }
}
