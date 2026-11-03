import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.svg': 'image/svg+xml', '.wav': 'audio/wav' };
const STAGES = new Set(['received', 'context', 'model', 'routine', 'memory', 'search_ready', 'tool_start', 'tool_result', 'camera_capture', 'camera_analyzing', 'output_check', 'delivered', 'interrupted', 'failed']);
const TOOLS = new Set(['create_timer', 'list_timers', 'cancel_timer', 'show_connections', 'web_search', 'read_web_page', 'camera_status', 'camera_look', 'home_list_devices', 'home_get_state', 'home_control', 'spotify_search', 'spotify_playlists', 'spotify_status', 'spotify_control', 'routine_save', 'routine_read', 'routine_use', 'routine_delete', 'memory_save_fact', 'memory_save_rule', 'memory_search', 'memory_read_document', 'memory_forget', 'memory_resolve_conflict']);

// Deliberately discard free text, arguments, evidence, results and provider metadata.
export function presentationEvent(stage, at_ms, data) {
  if (!STAGES.has(stage)) return null;
  return { stage, at_ms, ...(TOOLS.has(data?.tool) ? { tool: data.tool } : {}), ...(typeof data?.ok === 'boolean' ? { ok: data.ok } : {}), ...(stage === 'camera_capture' && typeof data?.capture_id === 'string' ? { capture_id: data.capture_id } : {}) };
}

export function connectionState(spotify, hub) {
  const status = spotify.status();
  const unavailable = () => ({ available: false, connected: false, status: 'unsupported' });
  const covered = hub?.coveredCategories?.() ?? new Set();
  // A category is "simulated" when only the labeled demo home covers it.
  const real = new Set((hub?.connectors ?? []).filter(connector => !connector.simulated && hub.isConnected(connector.id)).flatMap(connector => connector.kinds ?? []));
  const realKinds = { lights: ['light', 'room'], appliances: ['oven'] };
  const category = id => covered.has(id) ? { available: true, connected: true, status: 'connected', ...(realKinds[id]?.some(kind => real.has(kind)) ? {} : { simulated: true }) } : unavailable();
  return {
    spotify: { available: true, configured: status.configured === true, connected: status.connected === true, status: status.connected ? 'connected' : 'not_connected', voice_control: false },
    lights: category('lights'), oven: category('appliances'), schedules: unavailable(), cameras: unavailable(),
  };
}

const HOME_PANELS = { light: 'lights', room: 'lights', oven: 'oven', media: 'speaker' };

export function presentationResult(stage, data) {
  // The person's own words for a playlist they asked for by voice. Nothing has reached Spotify; the page waits for a tap.
  if (stage === 'music_offer' && typeof data?.playlist === 'string' && data.playlist.trim()) {
    const query = data.playlist.trim().slice(0, 60);
    return { type: 'music-offer', id: 'spotify', query, title: query.charAt(0).toUpperCase() + query.slice(1), status: 'ready' };
  }
  const result = data?.result ?? (stage === 'routine' ? data : undefined);
  if (!result || data?.ok === false) return null;
  if (data?.tool === 'show_connections') {
    // Only a category, a route ID, or a search phrase from the catalog; no household details.
    const text = value => typeof value === 'string' ? value.slice(0, 80) : '';
    return { type: 'connections', id: 'connections', category: text(result.category) || 'all', entry: text(result.entry), query: text(result.query), reason: text(result.reason) };
  }
  if (['create_timer', 'cancel_timer'].includes(data?.tool) && result.id) {
    return { type: 'timer', ...Object.fromEntries(['id', 'label', 'duration_seconds', 'ends_at', 'status', 'time_zone'].map(key => [key, result[key]])) };
  }
  if (data?.tool === 'home_control' && result.device) {
    // Only the code-written receipt: a reported state paints on/off, anything else stays "one moment".
    const device = result.device, type = HOME_PANELS[device.kind];
    if (!type) return null;
    const on = device.state?.on, text = value => typeof value === 'string' ? value.slice(0, 80) : '';
    const detail = type === 'oven' && on && Number.isFinite(device.state.temperature) ? `Preheating to ${device.state.temperature}${text(device.state.unit) || '°F'}` : '';
    return { type, id: text(device.id), label: text(device.name), status: result.confirmed && typeof on === 'boolean' ? (on ? 'on' : 'off') : 'pending', ...(detail ? { detail } : {}), ...(device.simulated === true ? { simulated: true } : {}) };
  }
  const routine = result.routine;
  if (routine?.id && (result.saved || result.read || result.started)) {
    return { type: result.saved ? 'routine-saved' : 'routine', id: routine.id, label: routine.name, trigger: routine.name, steps: [routine.prompt], status: result.saved ? 'saved' : 'ready' };
  }
  return null;
}

const CONNECTION_FILES = new Set(['index.html', 'app.js', 'styles.css', 'icons.js', 'catalog.js', 'integrations.js', 'live.js']);

export async function companionAsset(root, pathname) {
  let base;
  let relative;
  let live = false;
  let full = false;
  if (pathname === '/companion' || pathname === '/companion/') {
    base = resolve(root, 'public/companion'); relative = 'index.html';
  } else if (pathname === '/companionfull' || pathname === '/companionfull/') {
    // The robot-only home display: the same page and assistant, marked so it shows only MERLIN's stage.
    base = resolve(root, 'public/companion'); relative = 'index.html'; full = true;
  } else if (pathname.startsWith('/companion/')) {
    base = resolve(root, 'public/companion'); relative = pathname.slice('/companion/'.length);
  } else if (pathname.startsWith('/character/')) {
    base = resolve(root, 'assets/merlin-character'); relative = pathname.slice('/character/'.length);
    if (!(relative.startsWith('viewer/') || ['merlin-states.glb', 'states.json'].includes(relative))) return null;
  } else if (pathname === '/voice/recorder-worklet.js') {
    base = resolve(root, 'public/voice'); relative = 'recorder-worklet.js';
  } else if (pathname === '/connections' || pathname.startsWith('/connections/')) {
    // The Connection Center page and the same researched catalog the assistant uses.
    base = resolve(root, 'public/connections'); relative = pathname.slice('/connections'.length).replace(/^\//u, '') || 'index.html';
    if (!CONNECTION_FILES.has(relative)) return null;
    live = relative === 'index.html';
  } else return null;
  if (!TYPES[extname(relative)] || relative.split('/').some(piece => piece.startsWith('.') || piece === '..') || /[\\\u0000-\u001f]/u.test(relative)) return null;
  const file = resolve(base, relative);
  if (!file.startsWith(base + sep)) return null;
  try {
    const actual = await realpath(file);
    if (!actual.startsWith(await realpath(base) + sep)) return null;
    const content = full ? fullDisplay(await readFile(actual, 'utf8')) : await readFile(actual);
    const hashes = extname(relative) === '.html' ? [...content.toString('utf8').matchAll(/<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/gu)].map(match => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`) : [];
    return { type: TYPES[extname(relative)], content, hashes, live };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return null;
    throw error;
  }
}

/** The home-display variant of the companion page: full screen, no zoom, and installable to an iPad home screen. */
export function fullDisplay(html) {
  const marked = html.replace('<html lang="en">', '<html lang="en" data-mode="full">')
    .replace('<meta name="viewport" content="width=device-width,initial-scale=1">', '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="MERLIN">')
    .replace(/<title>[^<]*<\/title>/u, '<title>MERLIN</title>');
  if (!marked.includes('data-mode="full"')) throw new Error('The companion page no longer matches the full-display markers.');
  return Buffer.from(marked, 'utf8');
}

export function companionCsp(hashes = []) {
  return `default-src 'self'; script-src 'self' ${hashes.join(' ')}; style-src 'self'; connect-src 'self' blob:; media-src 'self' blob:; img-src 'self' blob: data: https://i.scdn.co https://mosaic.scdn.co; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
}
