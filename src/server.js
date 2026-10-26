import { createServer } from 'node:http';
import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TimerStore } from './timers.js';
import { MetaClient } from './meta.js';
import { Assistant } from './assistant.js';
import { RequestLedger } from './requests.js';
import { AppError, objectArgs, timeZone, uuid } from './errors.js';
import { MAX_MODEL_ROUNDS, MODEL_TIMEOUT_MS } from './limits.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

async function bodyOf(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new AppError('Send JSON content.', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new AppError('Request is too large.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('Request is not valid JSON.'); }
}

function publicError(error) {
  if (error instanceof AppError) return { status: error.status, message: error.message };
  if (error.code === 'INVALID_TIMER_ARGUMENT') return { status: 400, message: error.message };
  if (error.code === 'TIMER_NOT_FOUND') return { status: 404, message: 'That timer was not found. Refresh the timer list.' };
  return { status: 500, message: 'Local storage or server operation failed. Check the server and current timers before trying again.' };
}

export async function createApp({ dataDir = join(ROOT, 'data'), meta = new MetaClient({
  apiKey: process.env.META_API_KEY || process.env.MODEL_API_KEY,
  model: process.env.META_MODEL || 'muse-spark-1.3',
}), timers: suppliedTimers, ledger: suppliedLedger } = {}) {
  const timers = suppliedTimers || await new TimerStore({ filePath: join(dataDir, 'timers.json') }).init();
  const ledger = suppliedLedger || await new RequestLedger(join(dataDir, 'requests.jsonl')).init();
  const assistant = new Assistant({ meta, timers });
  const sessions = new Map();
  let schedulerFailure = false;
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try { await timers.tick(); schedulerFailure = false; }
    catch { schedulerFailure = true; }
    finally { ticking = false; }
  };
  const interval = setInterval(tick, 250);
  interval.unref();
  const state = async () => ({
    timers: await timers.list(), server_time: new Date().toISOString(),
    ...(schedulerFailure ? { warning: 'Timer persistence failed. Check local storage before relying on timer completion.' } : {}),
  });
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      const port = server.address()?.port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(req.headers.host)) throw new AppError('Only local access is allowed.', 403);
      if (req.headers.origin && !hosts.map(host => `http://${host}`).includes(req.headers.origin)) throw new AppError('Cross-origin requests are not allowed.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('Cross-site requests are not allowed.', 403);
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && PUBLIC_FILES.has(path)) {
        const [file, type] = PUBLIC_FILES.get(path);
        res.writeHead(200, { 'Content-Type': type });
        res.end(await readFile(join(ROOT, 'public', file)));
        return;
      }
      if (req.method === 'GET' && path === '/api/state') {
        await tick();
        json(200, {
          configured: meta.configured, model: meta.model,
          chat_timeout_ms: MAX_MODEL_ROUNDS * MODEL_TIMEOUT_MS + 30_000,
          ...await state(),
        });
        return;
      }
      if (req.method !== 'POST') throw new AppError('Not found.', 404);
      const body = await bodyOf(req);
      if (path === '/api/timers') {
        objectArgs(body, ['label', 'duration_seconds', 'time_zone', 'request_id']);
        uuid(body.request_id);
        timeZone(body.time_zone);
        const result = await ledger.run(`timer:${body.request_id}`, body, async () => {
          await timers.create({ label: body.label, duration_seconds: body.duration_seconds, time_zone: body.time_zone }, `manual:${body.request_id}`);
          return true;
        });
        json(result ? 200 : 500, await state());
        return;
      }
      const action = path.match(/^\/api\/timers\/([a-f0-9-]+)\/(cancel|dismiss)$/i);
      if (action) {
        objectArgs(body, []);
        await timers[action[2]](action[1]);
        json(200, await state());
        return;
      }
      if (path === '/api/session/reset') {
        objectArgs(body, ['session_id']); uuid(body.session_id);
        if (sessions.get(body.session_id)?.busy) throw new AppError('Wait for the current reply before clearing the conversation.', 409);
        sessions.delete(body.session_id);
        json(200, { ok: true });
        return;
      }
      if (path === '/api/chat') {
        objectArgs(body, ['message', 'time_zone', 'request_id', 'session_id']);
        uuid(body.request_id); uuid(body.session_id); timeZone(body.time_zone);
        if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 4000) throw new AppError('Enter a message between 1 and 4,000 characters.');
        if (!meta.configured) throw new AppError('Add META_API_KEY to .env and restart the server to connect Meta.', 503);
        const result = await ledger.run(`chat:${body.request_id}`, body, async () => {
          for (const [id, session] of sessions) if (!session.busy && session.used < Date.now() - 3_600_000) sessions.delete(id);
          if (!sessions.has(body.session_id)) {
            if (sessions.size >= 100) throw new AppError('Too many test conversations. Restart the server to clear them.', 429);
            sessions.set(body.session_id, { turns: [], busy: false, used: Date.now() });
          }
          const session = sessions.get(body.session_id);
          if (session.busy) throw new AppError('A reply is already in progress for this conversation.', 409);
          session.busy = true;
          session.used = Date.now();
          try {
            const response = await assistant.run({ ...body, history: session.turns.flat() });
            session.turns.push(response.turn);
            // Retain whole turns so function calls always keep their outputs.
            while (session.turns.length > 12 || (session.turns.length > 1 && JSON.stringify(session.turns).length > 200_000)) session.turns.shift();
            const { turn, ...visible } = response;
            return { status: 200, data: visible };
          } catch (error) {
            const safe = publicError(error);
            const events = error.tool_events || [];
            // Preserve factual outcomes without retaining an incomplete tool protocol.
            session.turns.push([
              { role: 'user', content: [{ type: 'input_text', text: body.message }] },
              { role: 'assistant', content: [{ type: 'output_text', text: `Reply failed: ${safe.message}\nConfirmed tool outcomes: ${JSON.stringify(events)}` }] },
            ]);
            while (session.turns.length > 12) session.turns.shift();
            return { status: safe.status, data: { error: safe.message, tool_events: events, sources: error.sources || [] } };
          } finally { session.busy = false; }
        });
        json(result.status, { ...result.data, ...await state() });
        return;
      }
      throw new AppError('Not found.', 404);
    } catch (error) {
      const safe = publicError(error);
      if (!res.headersSent) json(safe.status, { error: safe.message });
      else res.end();
    }
  });
  server.on('close', () => clearInterval(interval));
  return { server, timers, meta };
}

async function main() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const dataDir = join(ROOT, 'data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // TimerStore is single-writer. A second server must never share its file.
  const lockPath = join(dataDir, 'server.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lockPath, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid data/server.lock. Stop other MERLIN servers and inspect the lock.');
    try { process.kill(pid, 0); }
    catch (check) {
      if (check.code !== 'ESRCH') throw check;
      await unlink(lockPath);
      return main();
    }
    throw new Error('MERLIN is already running. Stop it before starting another server.');
  }
  await lock.writeFile(String(process.pid));
  const release = async () => { await lock.close(); await unlink(lockPath).catch(() => {}); };
  try {
    const { server, meta } = await createApp({ dataDir });
    await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
    console.log(`MERLIN test UI: http://127.0.0.1:${port}`);
    console.log(meta.configured ? `Meta adapter: ${meta.model} (credentials configured; use npm run check:meta to verify access).` : 'Meta key is not configured. Manual timers are available.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      server.close(async () => { await release(); process.exit(0); });
      server.closeIdleConnections();
    });
  } catch (error) { await release(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
