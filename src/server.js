import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TimerStore } from './timers.js';
import { MetaClient } from './meta.js';
import { Assistant } from './assistant.js';
import { RequestLedger } from './requests.js';
import { MemoryStore } from './memory-store.js';
import { MemoryService } from './memory.js';
import { MemoryLearning } from './memory-learning.js';
import { RoutinesStore, RoutineService } from './routines.js';
import { normalizeRule, checkOutput, checkTool, findConflicts, safeClarification } from './memory-rules.js';
import { AppError, objectArgs, timeZone, uuid } from './errors.js';
import { MAX_MODEL_ROUNDS, MODEL_TIMEOUT_MS } from './limits.js';
import { SpotifyService } from './spotify.js';
import { MetaTranscriber } from './voice/meta.js';
import { KokoroTts } from './voice/kokoro.js';
import { LocalVoiceListener } from './voice/listener.js';
import { attachVoiceSocket } from './voice/transport.js';
import { VOICE_SESSION_LIMITS } from './voice/session.js';
import { validateSpeechDelivery } from './voice/prosody.js';
import { checkCancelled } from './cancellation.js';
import { companionAsset, companionCsp, connectionState, presentationEvent, presentationResult } from './companion.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/memory.js', ['memory.js', 'text/javascript; charset=utf-8']],
  ['/spotify.js', ['spotify.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

async function bodyOf(request, maxSize = 16_384) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new AppError('Send JSON content.', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxSize) throw new AppError('Request is too large.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('Request is not valid JSON.'); }
}

function publicError(error) {
  if (error instanceof AppError) return { status: error.status, message: error.message };
  if (['INVALID_TIMER_ARGUMENT', 'INVALID_MEMORY_ARGUMENT', 'INVALID_MEMORY_RULE', 'INVALID_ROUTINE_ARGUMENT'].includes(error.code)) return { status: 400, message: error.message };
  if (error.code === 'MEMORY_NOT_FOUND') return { status: 404, message: error.message };
  if (error.code === 'MEMORY_STALE_OPERATION') return { status: 409, message: 'Memory changed during this operation. Refresh and try again.' };
  if (error.code === 'TIMER_NOT_FOUND') return { status: 404, message: 'That timer was not found. Refresh the timer list.' };
  return { status: 500, message: 'Local storage or server operation failed. Check the server and current timers before trying again.' };
}

export async function createApp({ dataDir = join(ROOT, 'data'), meta = new MetaClient({
  apiKey: process.env.META_API_KEY || process.env.MODEL_API_KEY,
  model: process.env.META_MODEL || 'muse-spark-1.3',
}), timers: suppliedTimers, ledger: suppliedLedger, memoryStore: suppliedMemory, spotify: suppliedSpotify, learningDelayMs = 750, voiceMeta = new MetaTranscriber({ apiKey: process.env.META_API_KEY || process.env.MODEL_API_KEY }), tts = new KokoroTts(), listener = new LocalVoiceListener() } = {}) {
  const timers = suppliedTimers || await new TimerStore({ filePath: join(dataDir, 'timers.json') }).init();
  const ledger = suppliedLedger || await new RequestLedger(join(dataDir, 'requests.jsonl')).init();
  const store = suppliedMemory || await new MemoryStore({ filePath: join(dataDir, 'memory.json') }).init();
  const memory = new MemoryService(store);
  const spotify = suppliedSpotify || await new SpotifyService({ filePath: join(dataDir, 'spotify.json'), clientId: process.env.SPOTIFY_CLIENT_ID || '' }).init();
  const routineStore = await new RoutinesStore({ filePath: join(dataDir, 'routines.json') }).init();
  const routines = new RoutineService({ store: routineStore, memoryStore: store });
  const learning = await new MemoryLearning({ store, meta, filePath: join(dataDir, 'memory-learning.json'), delayMs: learningDelayMs }).init();
  const assistant = new Assistant({ meta, timers, memory, routines, spotify });
  const traces = new Map();
  const progress = new Map();
  const speechReplies = new Map();
  const speechPending = new Set();
  const inspect = sessionId => ({ ...memory.inspect(sessionId), ...routines.inspect(sessionId), learning: learning.status(), retention: 'Kept locally until you delete it. Clear all memory also removes transcripts, documents, routines, and learning jobs. Timers are separate.' });
  const clearCaches = () => { traces.clear(); progress.clear(); speechReplies.clear(); ledger.live.clear(); };
  const checkedMessage = message => {
    const rules = memory.rules();
    const checked = checkOutput(rules, message);
    return checked.violations.length || checked.conflicts.length ? safeClarification(rules, checked.conflicts) : checked.text;
  };
  const requireTool = (name, args) => {
    const gate = checkTool(memory.rules(), { name, args });
    if (!gate.ok) throw new AppError(gate.conflicts.length ? 'Resolve the flagged instructions in Memory lab before this action.' : gate.violations.map(item => item.message).join(' '));
    return gate.args;
  };
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
  const voiceStatus = async () => ({ metaConfigured: voiceMeta.configured, transcriptionModel: voiceMeta.model, voice: 'am_fenrir', tts: await tts.status(), listener: listener.status(), sessionLimits: VOICE_SESSION_LIMITS });
  const timerAlert = async timerId => {
    uuid(timerId);
    const timer = (await timers.list()).find(item => item.id === timerId);
    if (!timer || timer.status !== 'completed') throw new AppError('That timer is not ready for a finished announcement.', 409);
    const checked = checkOutput(memory.rules(), `Your “${timer.label}” timer is finished.`);
    if (checked.violations.length || checked.conflicts.length) throw new AppError('A saved instruction prevents this timer announcement.', 409);
    return { reply: checked.text, presentation: [presentationResult('tool_result', { tool: 'create_timer', ok: true, result: timer })] };
  };
  const runChatTurn = async (body, { signal, onProgress } = {}) => {
    objectArgs(body, ['message', 'time_zone', 'request_id', 'session_id', 'channel']);
    uuid(body.request_id); uuid(body.session_id); timeZone(body.time_zone);
    if (!['typed', 'voice'].includes(body.channel ?? 'typed')) throw new AppError('Choose typed or voice input.');
    if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 4000) throw new AppError('Enter a message between 1 and 4,000 characters.');
    checkCancelled(signal);
    if (!meta.configured) throw new AppError('Add META_API_KEY to .env and restart the server to connect Meta.', 503);
    const result = await ledger.run(`chat:${body.request_id}`, body, async () => {
      for (const [id, session] of sessions) if (!session.busy && session.used < Date.now() - 3_600_000) sessions.delete(id);
      if (!sessions.has(body.session_id)) {
        if (sessions.size >= 100) throw new AppError('Too many test conversations. Restart the server to clear them.', 429);
        sessions.set(body.session_id, { turns: [], busy: false, used: Date.now() });
      }
      const session = sessions.get(body.session_id);
      // Barge-in begins a new turn, but lets the cancelled turn finish recording
      // its actual receipts before the next turn reads conversation history.
      if (body.channel === 'voice' && session.busy && session.signal?.aborted) {
        await new Promise((resolveWait, rejectWait) => {
          const abortWait = () => rejectWait(new AppError('That request was interrupted. Completed actions are still shown.', 499));
          if (signal?.aborted) { abortWait(); return; }
          signal?.addEventListener('abort', abortWait, { once: true });
          session.finished.finally(() => { signal?.removeEventListener('abort', abortWait); resolveWait(); });
        });
        checkCancelled(signal);
      }
      if (session.busy) throw new AppError('A reply is already in progress for this conversation.', 409);
      session.busy = true;
      session.signal = signal;
      let finishSession;
      session.finished = new Promise(resolveFinished => { finishSession = resolveFinished; });
      session.used = Date.now();
      const requestEpoch = store.epoch;
      let inheritedIds = [];
      try {
        checkCancelled(signal);
        const history = memory.history(body.session_id);
        const prior = store.snapshot().conversations.filter(item => item.session_id === body.session_id);
        inheritedIds = prior.flatMap(item => item.memory_ids ?? []);
        const source = await store.recordMessage({ session_id: body.session_id, request_id: body.request_id, role: 'user', text: body.message });
        await routineStore.beginRequest({ session_id: body.session_id, request_id: body.request_id, message: body.message });
        const started = performance.now();
        const trace = { status: 'running', events: [], model_calls: 0, context_chars: 0, usage: null };
        traces.set(body.request_id, trace);
        while (traces.size > 50) traces.delete(traces.keys().next().value);
        const foreground = { status: 'running', events: [] };
        const presentation = new Map();
        progress.set(body.request_id, foreground);
        while (progress.size > 50) progress.delete(progress.keys().next().value);
        const onTrace = (stage, detail, data) => {
          const event = presentationEvent(stage, Math.round(performance.now() - started), data);
          if (event) {
            foreground.events.push(event);
            if (foreground.events.length > 256) foreground.events.shift();
            try { onProgress?.(event); } catch { /* Presentation cannot interrupt actions. */ }
          }
          const card = presentationResult(stage, data);
          if (card) presentation.set(card.type + ':' + card.id, card);
          trace.events.push({ stage, at_ms: Math.round(performance.now() - started), detail, ...(data === undefined ? {} : { data }) });
          if (stage === 'model') trace.model_calls++;
          if (stage === 'context') trace.context_chars = data.context_chars;
          if (stage === 'usage' && data) {
            trace.usage ??= { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
            trace.usage.input_tokens += data.input_tokens || 0; trace.usage.output_tokens += data.output_tokens || 0;
            trace.usage.cached_tokens += data.input_tokens_details?.cached_tokens || 0;
          }
        };
        onTrace('received', 'Saved the exact user message locally.', { source_id: source.id });
        let response;
        try { response = await assistant.run({ ...body, source_id: source.id, history, onTrace, signal }); }
        catch (error) { foreground.status = signal?.aborted ? 'interrupted' : 'failed'; onTrace(foreground.status, 'The foreground request stopped.'); trace.status = foreground.status; trace.total_ms = Math.round(performance.now() - started); error.trace = structuredClone(trace); throw error; }
        if (store.epoch !== requestEpoch) {
          clearCaches(); await learning.clear();
          if (response.forget_completed) presentation.clear();
          foreground.events = []; progress.set(body.request_id, foreground);
          trace.events = []; onTrace('invalidated', 'Removed earlier trace and cached replies after memory changed.');
          traces.set(body.request_id, trace);
        } else if (response.personality_changed) {
          clearCaches(); traces.set(body.request_id, trace); progress.set(body.request_id, foreground);
          onTrace('personality_context', 'Current style takes precedence; factual conversation and pending household learning are preserved.');
        }
        const presentIds = new Set([...store.snapshot().facts, ...memory.rules(), ...store.snapshot().documents, ...routineStore.list()].map(item => item.id));
        const memoryIds = [...new Set([...inheritedIds, ...(response.memory_ids || [])])].filter(id => presentIds.has(id));
        await store.recordMessage({ session_id: body.session_id, request_id: body.request_id, role: 'assistant', text: response.reply, turn: response.turn, memory_ids: memoryIds });
        foreground.status = 'complete';
        trace.status = 'complete'; trace.total_ms = Math.round(performance.now() - started);
        onTrace('delivered', 'Delivered the checked reply. Household learning runs in the background.');
        try { if (!response.forget_completed && !response.personality_changed) await learning.enqueue(source); }
        catch { onTrace('learning_error', 'Could not queue background learning. The reply and completed actions are preserved.'); }
        const { turn, memory_ids, forget_completed, ...visible } = response;
        speechReplies.set(body.request_id, response.reply);
        while (speechReplies.size > 50) speechReplies.delete(speechReplies.keys().next().value);
        return { status: 200, data: { ...visible, presentation: [...presentation.values()], trace: structuredClone(trace) } };
      } catch (error) {
        if (store.epoch !== requestEpoch) {
          clearCaches(); await learning.clear();
          error.trace = undefined; error.sources = []; error.memory_ids = []; inheritedIds = [];
        }
        const safe = publicError(error);
        const events = error.tool_events || [];
        const rules = memory.rules();
        const checked = checkOutput(rules, safe.message);
        const visibleError = checked.violations.length || checked.conflicts.length ? safeClarification(rules, checked.conflicts) : checked.text;
        const fallback = [
          { role: 'user', content: [{ type: 'input_text', text: store.epoch !== requestEpoch ? 'A memory-changing request was processed; original context was discarded.' : body.message }] },
          { role: 'assistant', content: [{ type: 'output_text', text: `Reply failed: ${visibleError}\nConfirmed tool outcomes: ${JSON.stringify(events)}` }] },
        ];
        await store.recordMessage({ session_id: body.session_id, request_id: body.request_id, role: 'assistant', text: visibleError, turn: fallback, memory_ids: [...new Set([...inheritedIds, ...(error.memory_ids ?? [])])] }).catch(() => {});
        return { status: safe.status, data: { error: visibleError, tool_events: events, sources: error.sources || [], ...(error.trace ? { trace: error.trace } : {}) } };
      } finally { session.busy = false; finishSession(); }
    });
    return { status: result.status, data: { ...result.data, personality: store.personality(), ...await state() } };
  };
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort); res.once('close', abort);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', companionCsp());
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
    const json = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      const port = server.address()?.port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(req.headers.host)) throw new AppError('Only local access is allowed.', 403);
      const url = new URL(req.url, 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      if (/[\\\u0000-\u001f]/u.test(path) || req.url.split('?')[0].split('/').some(segment => /^(?:\.|%2e){1,2}$/iu.test(segment))) throw new AppError('Not found.', 404);
      const callback = req.method === 'GET' && path === '/api/spotify/callback';
      // Spotify's redirect chain remains cross-site when it returns to the UI.
      // Allow only the static entry document; private API requests stay blocked.
      const entryNavigation = req.method === 'GET' && path === '/'
        && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      if (req.headers.origin && !hosts.map(host => `http://${host}`).includes(req.headers.origin)) throw new AppError('Cross-origin requests are not allowed.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site' && !callback && !entryNavigation) throw new AppError('Cross-site requests are not allowed.', 403);
      const spotifyRedirect = `http://127.0.0.1:${port}/api/spotify/callback`;
      if (callback) {
        // Only this API GET permits cross-site requests. The state must
        // match both this browser's HttpOnly cookie and the service's PKCE job.
        const state = url.searchParams.get('state') || '';
        const cookie = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('merlin_spotify_oauth='))?.slice('merlin_spotify_oauth='.length) || '';
        if (!/^[A-Za-z0-9_-]{32,128}$/.test(state) || !/^[A-Za-z0-9_-]{32,128}$/.test(cookie) || state.length !== cookie.length || !timingSafeEqual(Buffer.from(state), Buffer.from(cookie))) throw new AppError('Spotify connection expired or belongs to another browser. Connect again.', 403);
        res.setHeader('Set-Cookie', 'merlin_spotify_oauth=; Path=/api/spotify/callback; HttpOnly; SameSite=Lax; Max-Age=0');
        let outcome = 'connected';
        try {
          await spotify.completeAuthorization({ code: url.searchParams.get('error') ? '' : url.searchParams.get('code') || '', state, redirectUri: spotifyRedirect });
        } catch { outcome = url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'error'; }
        res.writeHead(303, { Location: `/?spotify=${outcome}#spotify-title` });
        res.end(); return;
      }
      if (['GET', 'HEAD'].includes(req.method) && (path.startsWith('/companion') || path.startsWith('/character/') || path === '/voice/recorder-worklet.js')) {
        const asset = await companionAsset(ROOT, path);
        if (!asset) throw new AppError('Not found.', 404);
        res.setHeader('Content-Security-Policy', companionCsp(asset.hashes));
        res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.content.length });
        res.end(req.method === 'HEAD' ? undefined : asset.content); return;
      }
      if (req.method === 'GET' && path === '/api/companion/state') {
        await tick();
        json(200, { configured: meta.configured, model: meta.model, chat_timeout_ms: MAX_MODEL_ROUNDS * MODEL_TIMEOUT_MS + 30_000,
          ...await state(), services: connectionState(spotify), voice: await voiceStatus() }); return;
      }
      if (req.method === 'GET' && path === '/api/voice/status') {
        json(200, await voiceStatus()); return;
      }
      if (req.method === 'GET' && path === '/api/companion/progress') {
        const requestId = url.searchParams.get('request_id'); uuid(requestId);
        json(200, progress.get(requestId) ?? { status: 'pending', events: [] }); return;
      }
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
      if (req.method === 'GET' && path === '/api/spotify/status') {
        json(200, { ...spotify.status(), redirect_uri: spotifyRedirect }); return;
      }
      if (req.method === 'GET' && path === '/api/spotify') {
        requireTool('spotify_status', {});
        json(200, await spotify.snapshot({ refresh: url.searchParams.get('refresh') === '1' })); return;
      }
      if (req.method === 'GET' && path === '/api/memory') {
        const sessionId = url.searchParams.get('session_id'); if (sessionId) uuid(sessionId);
        json(200, inspect(sessionId)); return;
      }
      if (path === '/api/personality' && req.method === 'GET') {
        json(200, store.personality()); return;
      }
      if (path === '/api/personality' && req.method === 'PUT') {
        if ([...sessions.values()].some(session => session.busy)) throw new AppError('Wait for the current reply before changing personality.', 409);
        const settings = await store.setPersonality(await bodyOf(req));
        clearCaches();
        json(200, settings); return;
      }
      if (req.method === 'GET' && path === '/api/trace') {
        const requestId = url.searchParams.get('request_id'); uuid(requestId);
        json(200, traces.get(requestId) ?? { status: 'pending', events: [] }); return;
      }
      if (req.method === 'GET' && path.startsWith('/api/documents/')) {
        const id = decodeURIComponent(path.slice('/api/documents/'.length));
        const document = store.snapshot().documents.find(item => item.id === id);
        if (!document) throw new AppError('Document not found.', 404);
        json(200, document); return;
      }
      if (req.method !== 'POST') throw new AppError('Not found.', 404);
      const body = await bodyOf(req, path === '/api/documents' ? 650_000 : path === '/api/routines' ? 90_000 : 16_384);
      if (path === '/api/companion/speak' || path === '/api/companion/timer-speech') {
        const announcement = path === '/api/companion/timer-speech';
        objectArgs(body, [announcement ? 'timer_id' : 'request_id', 'delivery', 'speed']);
        uuid(announcement ? body.timer_id : body.request_id);
        const text = announcement ? (await timerAlert(body.timer_id)).reply : speechReplies.get(body.request_id);
        if (!text) throw new AppError('That reply is no longer available to read aloud.', 404);
        if (voiceSocket.active) throw new AppError('A wake conversation already controls speech.', 409);
        const checked = checkOutput(memory.rules(), text);
        if (checked.violations.length || checked.conflicts.length) throw new AppError('The reply cannot be spoken under the current instructions.', 409);
        const delivery = validateSpeechDelivery(body.delivery);
        const speed = body.speed ?? 1;
        if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.75 || speed > 1.25) throw new AppError('Speech speed must be between 0.75 and 1.25.');
        speechPending.add(controller);
        try {
          const audio = await tts.synthesize(checked.text, { delivery, speed, signal: controller.signal });
          if (!controller.signal.aborted && !res.destroyed) {
            res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length }); res.end(audio);
          }
        } finally { speechPending.delete(controller); }
        return;
      }
      if (path === '/api/spotify/config') {
        objectArgs(body, ['client_id']);
        await spotify.configure(body.client_id);
        json(200, { ...spotify.status(), redirect_uri: spotifyRedirect }); return;
      }
      if (path === '/api/spotify/connect') {
        objectArgs(body, []);
        if (req.headers.host !== `127.0.0.1:${port}`) throw new AppError(`Open http://127.0.0.1:${port} before connecting Spotify.`);
        const auth = spotify.beginAuthorization(spotifyRedirect);
        res.setHeader('Set-Cookie', `merlin_spotify_oauth=${auth.state}; Path=/api/spotify/callback; HttpOnly; SameSite=Lax; Max-Age=600`);
        json(200, { url: auth.url }); return;
      }
      if (path === '/api/spotify/disconnect') {
        objectArgs(body, []); await spotify.disconnect();
        json(200, spotify.status()); return;
      }
      if (path === '/api/spotify/search') {
        objectArgs(body, ['query', 'type']);
        json(200, await spotify.search(requireTool('spotify_search', body))); return;
      }
      if (path === '/api/spotify/playlists') {
        objectArgs(body, []); requireTool('spotify_playlists', {});
        json(200, await spotify.playlists()); return;
      }
      if (path === '/api/spotify/control') {
        objectArgs(body, ['request_id', 'action', 'uri', 'query', 'type', 'device_id', 'device_name', 'volume_percent', 'state']);
        uuid(body.request_id);
        const { request_id: requestId, ...args } = body;
        const result = await ledger.run(`spotify:${requestId}`, body, () => spotify.control(requireTool('spotify_control', args)));
        json(200, result); return;
      }
      if (path.startsWith('/api/memory/') || path === '/api/documents' || path === '/api/routines' || path === '/api/routines/delete') {
        if ([...sessions.values()].some(session => session.busy)) throw new AppError('Wait for the current reply before editing memory.', 409);
        const beforeEpoch = store.epoch;
        if (path === '/api/routines' || path === '/api/routines/delete') {
          objectArgs(body, path === '/api/routines' ? ['id', 'name', 'aliases', 'prompt'] : ['id']);
          const previous = routineStore.list().find(routine => routine.id === body.id);
          if (path === '/api/routines/delete') await routineStore.remove(body.id);
          else await routineStore.save({ ...body, source_id: 'manual', source_quote: '' });
          if (previous) await store.invalidateReferences({ ids: [previous.id], source_ids: [...new Set([previous.source_id, ...(previous.definition_sources ?? []).map(source => source.source_id)])] });
        } else if (path === '/api/memory/fact') {
          objectArgs(body, ['id', 'content', 'subject', 'kind']);
          await store.putFact({ content: body.content, subject: body.subject || 'household', kind: body.kind || 'fact', source_id: 'manual', source_quote: '', reason: 'Edited directly in Memory lab.', ...(body.id ? { supersedes: body.id } : {}) });
        } else if (path === '/api/memory/rule') {
          objectArgs(body, ['kind', 'value', 'scope', 'original']);
          const original = body.original || `${body.kind}: ${body.value}`;
          await store.putRule(normalizeRule({ ...body, original, explanation: 'Configured directly in Memory lab with explicit scope.', source_id: 'manual', source_quote: '' }));
        } else if (path === '/api/memory/delete') {
          objectArgs(body, ['collection', 'id']); await store.remove(body); clearCaches();
        } else if (path === '/api/memory/resolve') {
          objectArgs(body, ['keep_id', 'remove_ids']);
          if (!Array.isArray(body.remove_ids) || !findConflicts(memory.rules()).some(c => c.rule_ids.includes(body.keep_id) && body.remove_ids.every(id => id !== body.keep_id && c.rule_ids.includes(id)))) throw new AppError('Choose rules from an existing conflict.');
          await store.resolveRules(body); clearCaches();
        } else if (path === '/api/documents') {
          objectArgs(body, ['id', 'title', 'description', 'content']); await store.putDocument(body); if (body.id) clearCaches();
        } else if (path === '/api/memory/clear') {
          objectArgs(body, []); await learning.clear(); await routineStore.clear(); await store.clearAll(); sessions.clear(); clearCaches();
        } else if (path === '/api/memory/retry-learning') {
          objectArgs(body, []); await learning.retry();
        } else throw new AppError('Not found.', 404);
        if (store.epoch !== beforeEpoch) { clearCaches(); await learning.clear(); }
        json(200, { ok: true, ...inspect() }); return;
      }
      if (path === '/api/timers') {
        objectArgs(body, ['label', 'duration_seconds', 'time_zone', 'request_id']);
        uuid(body.request_id);
        timeZone(body.time_zone);
        const result = await ledger.run(`timer:${body.request_id}`, body, async () => {
          const args = requireTool('create_timer', { label: body.label, duration_seconds: body.duration_seconds });
          await timers.create({ ...args, time_zone: body.time_zone }, `manual:${body.request_id}`);
          return true;
        });
        json(result ? 200 : 500, await state());
        return;
      }
      const action = path.match(/^\/api\/timers\/([a-f0-9-]+)\/(cancel|dismiss)$/i);
      if (action) {
        objectArgs(body, []);
        if (action[2] === 'cancel') requireTool('cancel_timer', { timer_id: action[1] });
        await timers[action[2]](action[1]);
        json(200, await state());
        return;
      }
      if (path === '/api/session/reset') {
        objectArgs(body, ['session_id']); uuid(body.session_id);
        if (sessions.get(body.session_id)?.busy) throw new AppError('Wait for the current reply before clearing the conversation.', 409);
        await store.clearConversation(body.session_id);
        await routineStore.clearSession(body.session_id);
        await learning.clear();
        sessions.delete(body.session_id); clearCaches();
        json(200, { ok: true });
        return;
      }
      if (path === '/api/chat') {
        const result = await runChatTurn(body, { signal: controller.signal });
        if (!res.destroyed) json(result.status, result.data);
        return;
      }
      throw new AppError('Not found.', 404);
    } catch (error) {
      const safe = publicError(error);
      if (!res.headersSent) json(safe.status, { error: req.url?.split('?')[0] === '/api/chat' ? checkedMessage(safe.message) : safe.message });
      else res.end();
    } finally { req.off('aborted', abort); res.off('close', abort); }
  });
  const voiceSocket = attachVoiceSocket({ server, listener, meta: voiceMeta, tts, isBusy: () => speechPending.size > 0, timerAlert,
    respond: async (text, { signal, onProgress, sessionId, timeZone: zone, requestId }) => {
      const result = await runChatTurn({ message: text, session_id: sessionId, time_zone: zone, request_id: requestId, channel: 'voice' }, { signal, onProgress });
      const { trace, ...response } = result.data;
      // Checked failures retain confirmed outcomes for the panel and speech.
      // VoiceSession still discards the entire result when its revision changed.
      return { ...response, reply: response.reply ?? response.error };
    },
  });
  const closeVoice = () => { voiceSocket.close(); listener.close(); for (const pending of speechPending) pending.abort(); Promise.resolve(tts.close()).catch(() => {}); };
  server.on('close', () => { clearInterval(interval); closeVoice(); learning.close().catch(() => {}); });
  return { server, timers, meta, store, memory, learning, routines, routineStore, spotify, runChatTurn, timerAlert, closeVoice };

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
    const { server, meta, closeVoice } = await createApp({ dataDir });
    await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
    console.log(`MERLIN test UI: http://127.0.0.1:${port}`);
    console.log(meta.configured ? `Meta adapter: ${meta.model} (credentials configured; use npm run check:meta to verify access).` : 'Meta key is not configured. Manual timers are available.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      closeVoice();
      server.close(async () => { await release(); process.exit(0); });
      server.closeIdleConnections();
    });
  } catch (error) { await release(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
