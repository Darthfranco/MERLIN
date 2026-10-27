import { AppError, objectArgs } from './errors.js';

const tool = (name, description, properties = {}, required = Object.keys(properties)) => ({
  type: 'function', name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false },
});
const text = description => ({ type: 'string', description });
const TYPES = ['track', 'album', 'artist', 'playlist'];
export const SPOTIFY_TOOL_NAMES = Object.freeze(['spotify_search', 'spotify_playlists', 'spotify_status', 'spotify_control']);
export const SPOTIFY_TOOLS = [
  tool('spotify_search', 'Search Spotify for the typed request and show results in the Spotify panel. Results are never available to you. This does not start playback.', {
    query: text('Search terms from the user request.'), type: { type: 'string', enum: TYPES },
  }),
  tool('spotify_playlists', 'Show the connected user’s playlists in the Spotify panel. Playlist content is not returned to you.'),
  tool('spotify_status', 'Refresh player state and available playback devices in the Spotify panel. No track, artist, playlist or device metadata is returned to you.'),
  tool('spotify_control', 'Send a requested Spotify control. Use only fields needed by this action. A successful request is accepted, not proof that playback changed. Ambiguous searches require a selection in the Spotify panel. Never use for alarms, alerts, scheduled playback or voice control.', {
    action: { type: 'string', enum: ['play', 'pause', 'next', 'previous', 'volume', 'shuffle', 'repeat', 'transfer', 'queue'] },
    query: text('For play or queue, music requested by the user; omit to resume playback.'),
    type: { type: 'string', enum: TYPES },
    uri: text('Exact Spotify URI explicitly supplied by the user. Never invent or infer an identifier.'),
    device_name: text('Exact device name supplied by the user. Never infer a name from Spotify results; those are only in the panel.'),
    volume_percent: { type: 'integer', minimum: 0, maximum: 100 },
    state: { anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['off', 'track', 'context'] }], description: 'Boolean for shuffle; off, track or context for repeat.' },
  }, ['action']),
];

export const SPOTIFY_INSTRUCTIONS = `Spotify is implemented for typed requests through the connected Spotify account. Use spotify_search, spotify_playlists, spotify_status or spotify_control when requested; if disconnected say "Connect Spotify below first." Do not claim music is unimplemented. Spotify playback requires the supported connected account and an available Spotify device. This is not voice control, a music alarm, or a recurring playback scheduler.
Spotify content, metadata and account/device details stay exclusively in the browser Spotify panel. Never request, guess, summarize, quote, analyze, remember or infer those API results. You may interpret music names the user types; Spotify resolves the selection locally. Exact user-supplied Spotify URIs or device names may be used, but never invent identifiers or copy identifiers from external pages. For ambiguous selections direct the user to the panel; do not choose for them.
Tool receipts are authoritative and intentionally generic. An accepted command only means the request was sent; never claim playback is playing, paused, skipped, queued or otherwise verified. The application adds the exact Spotify receipt to the final response. In your final answer address any independent non-Spotify work, and omit Spotify outcome wording. Never let routine setup, examples, hypothetical actions, or routine lookup execute Spotify operations. An explicitly activated saved routine follows the same normal checks. Do not use web search as a replacement for Spotify library/player access.`;

export function isSpotifyTool(name) { return SPOTIFY_TOOL_NAMES.includes(name); }

/** Only complete explicit controls; semantic household guidance stays on the model path. */
export function parseSimpleSpotifyControl(message) {
  if (typeof message !== 'string') return null;
  const value = message.normalize('NFKC').toLowerCase().trim().replace(/[.!]+$/u, '').trim()
    .replace(/^merlin[,\s]+/u, '').replace(/^please\s+/u, '').replace(/\s+please$/u, '').trim();
  if (/^pause\s+(?:spotify|(?:my\s+|the\s+)?music)$/u.test(value)) return { action: 'pause' };
  if (/^(?:resume|continue|play)\s+(?:spotify|(?:my\s+|the\s+)?music)$/u.test(value)) return { action: 'play' };
  if (/^(?:skip\s+(?:the\s+)?(?:track|song)|next\s+(?:track|song))(?:\s+on\s+spotify)?$/u.test(value)) return { action: 'next' };
  if (/^(?:previous\s+(?:track|song)|go\s+back\s+to\s+the\s+previous\s+(?:track|song))(?:\s+on\s+spotify)?$/u.test(value)) return { action: 'previous' };
  return null;
}

const FAILURE = Object.freeze({
  SPOTIFY_NOT_CONFIGURED: 'Connect Spotify below first.',
  SPOTIFY_NOT_CONNECTED: 'Connect Spotify below first.',
  SPOTIFY_AUTHORIZATION: 'Reconnect Spotify in the panel below.',
  SPOTIFY_STALE: 'Reconnect Spotify in the panel below.',
  SPOTIFY_RATE_LIMITED: 'Spotify is busy. Please try again shortly.',
  SPOTIFY_PREMIUM: 'This Spotify control needs a supported Premium account.',
  SPOTIFY_DEVICE: 'Open Spotify on a playback device, then choose it in the Spotify panel.',
  SPOTIFY_UNAVAILABLE: 'Spotify did not confirm the request. Check playback before trying again.',
  SPOTIFY_INVALID: 'Check the Spotify request and try again.',
});
function string(value, maximum) { return typeof value === 'string' && !!value.trim() && value.length <= maximum && !/[\u0000-\u001F\u007F]/u.test(value); }
function supplied(value, message) {
  return string(value, 200) && typeof message === 'string' && message.includes(value);
}

/** This boundary never forwards an API response or an upstream error message. */
export async function executeSpotifyTool(spotify, name, args, { message = '' } = {}) {
  if (!isSpotifyTool(name)) throw new AppError('This Spotify operation is not available.');
  objectArgs(args, name === 'spotify_search' ? ['query', 'type'] : name === 'spotify_control'
    ? ['action', 'query', 'type', 'uri', 'device_name', 'volume_percent', 'state'] : []);
  if (name === 'spotify_search' && (!string(args.query, 300) || !TYPES.includes(args.type))) throw new AppError('Give a music search and choose track, album, artist or playlist.');
  if (name === 'spotify_control') {
    if (Object.hasOwn(args, 'uri') && !supplied(args.uri, message)) throw new AppError('Use a Spotify link from your request or choose music in the Spotify panel.');
    if (Object.hasOwn(args, 'device_name') && !supplied(args.device_name, message)) throw new AppError('Name the playback device or choose it in the Spotify panel.');
  }
  try {
    const status = spotify?.status();
    if (!status?.connected) return { ok: false, status: 'connection_required', message: 'Connect Spotify below first.' };
    if (name === 'spotify_search') {
      await spotify.search(args);
      return { ok: true, status: 'displayed', message: 'Results are in the Spotify panel.' };
    }
    if (name === 'spotify_playlists') {
      await spotify.playlists();
      return { ok: true, status: 'displayed', message: 'Your playlists are in the Spotify panel.' };
    }
    if (name === 'spotify_status') {
      await spotify.snapshot();
      return { ok: true, status: 'displayed', message: 'Player details and devices are in the Spotify panel.' };
    }
    const result = await spotify.control(args);
    if (result?.ok === true && result.status === 'accepted') return { ok: true, status: 'accepted', message: 'Request sent to Spotify. Check the panel for playback status.' };
    if (result?.ok === true && result.status === 'choice_required') return { ok: true, status: 'choice_required', message: 'Choose the music or device in the Spotify panel.' };
    return { ok: false, status: 'failed', message: 'Spotify could not complete that request. Please try again.' };
  } catch (error) {
    return { ok: false, status: 'failed', message: FAILURE[error?.code] ?? 'Spotify could not complete that request. Please try again.' };
  }
}

/** Preserve independent answers while replacing unsupported playback claims. */
export function spotifyReply(reply, receipts) {
  if (!receipts.length) return reply;
  const pieces = reply.split(/(?<=[.!?])\s+|\n+/u);
  const independent = pieces.filter(piece => !/\bspotify\b/iu.test(piece)
    && !/\b(?:now playing|is playing|are playing|is paused|has (?:started|stopped)|(?:i(?:'ve| have)?|i) (?:started|paused|resumed|skipped|queued|transferred)|(?:playback|music|song|track|volume|shuffle|repeat) (?:is|has|was|set|started|paused|resumed)|(?:started|paused|resumed|skipped|queued|transferred) (?:the |your |a )?(?:music|song|track|playback|playlist))\b/iu.test(piece));
  return [...independent.filter(piece => piece.trim() && !/^(?:done|sure|ok(?:ay)?|all set)[.!]?$/iu.test(piece.trim())), ...new Set(receipts.map(receipt => receipt.message))].join(' ').trim();
}
