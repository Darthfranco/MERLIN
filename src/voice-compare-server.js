import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VoiceComparison, ROOT } from './voice-compare.js';

const FILES = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]]);
function send(req, res, status, value, type = 'application/json; charset=utf-8') {
  if (res.destroyed) return;
  const body = Buffer.isBuffer(value) ? value : Buffer.from(type.startsWith('application/json') ? JSON.stringify(value) : value);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length }); res.end(req.method === 'HEAD' ? undefined : body);
}
async function body(req, limit) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Use a JSON request.');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('The request is too large.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('The request is not valid JSON.'); }
}

export function createVoiceCompareServer({ lab = new VoiceComparison(), publicRoot = join(ROOT, 'public/voice-compare') } = {}) {
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const port = server.address()?.port;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host) || req.headersDistinct.host?.length !== 1) return send(req, res, 403, { error: 'Only local access is allowed.' });
    const navigation = ['GET', 'HEAD'].includes(req.method) && ['/', '/index.html'].includes(req.url) && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
    if ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || (req.headers['sec-fetch-site'] === 'cross-site' && !navigation)) return send(req, res, 403, { error: 'Cross-origin requests are not allowed.' });
    let path;
    try { path = decodeURIComponent(req.url.split('?')[0]); if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(path) || path.split('/').includes('..')) throw new Error(); } catch { return send(req, res, 400, { error: 'Invalid request path.' }); }
    try {
      if (['GET', 'HEAD'].includes(req.method)) {
        if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
        if (FILES.has(path)) { const [name, type] = FILES.get(path); return send(req, res, 200, await readFile(join(publicRoot, name)), type); }
        if (path === '/api/status') return send(req, res, 200, lab.snapshot());
        if (path === '/health') return send(req, res, 200, { ok: true, service: 'voice-compare' });
        if (path.startsWith('/audio/')) { try { return send(req, res, 200, await lab.audio(path.slice(7)), 'audio/wav'); } catch { return send(req, res, 404, { error: 'Audio not found.' }); } }
      }
      if (req.method === 'POST') {
        if (path === '/api/run') return send(req, res, 202, { id: await lab.start(await body(req, 10_000)) });
        if (path === '/api/reference') return send(req, res, 200, await lab.setReference(await body(req, 8_100_000)));
        if (path === '/api/stop') { await body(req, 100); await lab.stop(); return send(req, res, 200, lab.snapshot()); }
        if (path === '/api/clear') { await body(req, 100); await lab.clear(); return send(req, res, 200, lab.snapshot()); }
        if (path === '/api/refresh') { await body(req, 100); await lab.refresh(); return send(req, res, 200, lab.snapshot()); }
      }
      return send(req, res, 404, { error: 'Not found.' });
    } catch (error) { return send(req, res, 400, { error: error.message || 'The request could not be completed.' }); }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  return { server, lab };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.VOICE_COMPARE_PORT || 3004);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('VOICE_COMPARE_PORT must be a valid port.');
  const { server, lab } = createVoiceCompareServer();
  await lab.init();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Set VOICE_COMPARE_PORT to another port.` : 'Voice comparison could not start.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`MERLIN voice comparison: http://127.0.0.1:${port}`));
  void lab.refresh();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await lab.stop(); server.close(); server.closeAllConnections(); });
}
