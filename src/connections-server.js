import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PUBLIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/connections');
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/catalog.js', ['catalog.js', 'text/javascript; charset=utf-8']],
  ['/icons.js', ['icons.js', 'text/javascript; charset=utf-8']],
  ['/state.js', ['state.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function respond(req, res, status, type, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function json(req, res, status, value) {
  respond(req, res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

// Return an unstarted server so importing this demo cannot bind a port or load credentials.
export function createConnectionsServer({ publicRoot = PUBLIC_ROOT } = {}) {
  const root = resolve(publicRoot);
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', CSP);

    const port = server.address()?.port;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)
      || req.headersDistinct.host?.length !== 1) {
      json(req, res, 403, { error: 'Only local access is allowed.' });
      return;
    }
    // A clicked link may navigate here from another site; only the demo document is public to that navigation.
    const documentNavigation = ['GET', 'HEAD'].includes(req.method)
      && req.headers['sec-fetch-mode'] === 'navigate'
      && req.headers['sec-fetch-dest'] === 'document'
      && ['/', '/index.html'].includes(req.url?.split('?')[0]);
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

    // Inspect the path before URL normalization could erase traversal segments.
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
      json(req, res, 200, { ok: true, mode: 'demo' });
      return;
    }
    const entry = FILES.get(pathname);
    if (!entry) {
      json(req, res, 404, { error: 'Not found.' });
      return;
    }

    let file;
    try {
      // Only fixed filenames are read; symlinks cannot turn a public asset into a private-file route.
      file = await open(join(root, entry[0]), constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!(await file.stat()).isFile()) {
        json(req, res, 404, { error: 'Not found.' });
        return;
      }
      const content = await file.readFile();
      respond(req, res, 200, entry[1], content);
    } catch (error) {
      const missing = ['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP'].includes(error.code);
      json(req, res, missing ? 404 : 500, { error: missing ? 'Not found.' : 'The connection demo could not load this file.' });
    } finally {
      await file?.close();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.CONNECTIONS_PORT || 3002);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CONNECTIONS_PORT must be a valid port.');
  const server = createConnectionsServer();
  server.once('error', error => {
    console.error(error.code === 'EADDRINUSE'
      ? `Connection demo port ${port} is in use. Set CONNECTIONS_PORT to another port.`
      : 'The connection demo could not start.');
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`MERLIN Connection Center (demo): http://127.0.0.1:${port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close(error => { if (error) process.exitCode = 1; });
      server.closeAllConnections();
    });
  }
}
