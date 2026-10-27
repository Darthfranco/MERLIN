import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.svg': 'image/svg+xml' };
const STAGES = new Set(['received', 'context', 'model', 'routine', 'memory', 'search_ready', 'tool_start', 'tool_result', 'output_check', 'delivered', 'interrupted', 'failed']);
const TOOLS = new Set(['create_timer', 'list_timers', 'cancel_timer', 'web_search', 'spotify_search', 'spotify_playlists', 'spotify_status', 'spotify_control', 'routine_save', 'routine_read', 'routine_use', 'routine_delete', 'memory_save_fact', 'memory_save_rule', 'memory_search', 'memory_read_document', 'memory_forget', 'memory_resolve_conflict']);

// Deliberately discard free text, arguments, evidence, results and provider metadata.
export function presentationEvent(stage, at_ms, data) {
  if (!STAGES.has(stage)) return null;
  return { stage, at_ms, ...(TOOLS.has(data?.tool) ? { tool: data.tool } : {}), ...(typeof data?.ok === 'boolean' ? { ok: data.ok } : {}) };
}

export function connectionState(spotify) {
  const status = spotify.status();
  const unavailable = () => ({ available: false, connected: false, status: 'unsupported' });
  return {
    spotify: { available: true, configured: status.configured === true, connected: status.connected === true, status: status.connected ? 'connected' : 'not_connected', voice_control: false },
    lights: unavailable(), oven: unavailable(), schedules: unavailable(), cameras: unavailable(),
  };
}

export function presentationResult(stage, data) {
  const result = data?.result ?? (stage === 'routine' ? data : undefined);
  if (!result || data?.ok === false) return null;
  if (['create_timer', 'cancel_timer'].includes(data?.tool) && result.id) {
    return { type: 'timer', ...Object.fromEntries(['id', 'label', 'duration_seconds', 'ends_at', 'status', 'time_zone'].map(key => [key, result[key]])) };
  }
  const routine = result.routine;
  if (routine?.id && (result.saved || result.read || result.started)) {
    return { type: result.saved ? 'routine-saved' : 'routine', id: routine.id, label: routine.name, trigger: routine.name, steps: [routine.prompt], status: result.saved ? 'saved' : 'ready' };
  }
  return null;
}

export async function companionAsset(root, pathname) {
  let base;
  let relative;
  if (pathname === '/companion' || pathname === '/companion/') {
    base = resolve(root, 'public/companion'); relative = 'index.html';
  } else if (pathname.startsWith('/companion/')) {
    base = resolve(root, 'public/companion'); relative = pathname.slice('/companion/'.length);
  } else if (pathname.startsWith('/character/')) {
    base = resolve(root, 'assets/merlin-character'); relative = pathname.slice('/character/'.length);
    if (!(relative.startsWith('viewer/') || ['merlin-states.glb', 'states.json'].includes(relative))) return null;
  } else if (pathname === '/voice/recorder-worklet.js') {
    base = resolve(root, 'public/voice'); relative = 'recorder-worklet.js';
  } else return null;
  if (!TYPES[extname(relative)] || relative.split('/').some(piece => piece.startsWith('.') || piece === '..') || /[\\\u0000-\u001f]/u.test(relative)) return null;
  const file = resolve(base, relative);
  if (!file.startsWith(base + sep)) return null;
  try {
    const actual = await realpath(file);
    if (!actual.startsWith(await realpath(base) + sep)) return null;
    const content = await readFile(actual);
    const hashes = extname(relative) === '.html' ? [...content.toString('utf8').matchAll(/<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/gu)].map(match => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`) : [];
    return { type: TYPES[extname(relative)], content, hashes };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return null;
    throw error;
  }
}

export function companionCsp(hashes = []) {
  return `default-src 'self'; script-src 'self' ${hashes.join(' ')}; style-src 'self'; connect-src 'self' blob:; media-src 'self' blob:; img-src 'self' blob: data: https://i.scdn.co https://mosaic.scdn.co; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
}
