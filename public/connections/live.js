// Pure helpers for the Connection Center. No DOM, no network: app.js owns both, and node tests import this file.
// Status always comes from MERLIN's connector hub (GET /api/connectors). Nothing here invents or remembers a connection.
import { SPOTIFY_INTEGRATION } from './integrations.js';

export const STATUS = Object.freeze({
  connected: { label: 'Connected', tone: 'ok', icon: 'check' },
  saved: { label: 'Setup unfinished', tone: 'warn', icon: 'clock' },
  attention: { label: 'Needs attention', tone: 'bad', icon: 'alert' },
  not_connected: { label: 'Not connected', tone: 'neutral', icon: 'plug' },
  unavailable: { label: 'Unavailable', tone: 'neutral', icon: 'alert' },
});

/** Spotify is not a catalog entry: it is set up on MERLIN's main page, and this card only reports and disconnects. */
export const SPOTIFY_ENTRY = Object.freeze({
  id: 'spotify', name: 'Spotify', company: 'Spotify', aliases: ['music', 'playlists', 'Spotify Connect'], categoryIds: ['speakers'],
  description: 'Search for music and control playback on your own Spotify devices by typing.',
  difficulty: 'easy', difficultyReason: 'Easy once you have Spotify Premium and your own free developer app.',
  method: 'Your Spotify developer app',
  requirements: ['A Spotify Premium account.', 'A free Spotify developer app and its Client ID.', 'Spotify open on a speaker, computer or phone.'],
  steps: [
    { title: 'Create a free developer app', body: 'In the Spotify developer dashboard create an app, add the redirect address MERLIN shows you, and copy its Client ID.' },
    { title: 'Paste the Client ID and connect', body: 'Do this on the main MERLIN page. Spotify asks you to approve access on its own site; MERLIN never sees your Spotify password.' },
    { title: 'Choose a playback device', body: 'Open Spotify on a device, then pick it in the Spotify panel.' },
  ],
  limitations: ['Music works by typing or on the music panel, not by voice.', 'Disconnect removes the tokens from MERLIN. To fully revoke access, also remove MERLIN in your Spotify account under Apps.'],
  guideUrl: 'https://developer.spotify.com/documentation/web-api/concepts/apps', availability: 'standard',
  integration: SPOTIFY_INTEGRATION, external: true,
});

const RANK = { native: 0, 'via-home-assistant': 1, none: 2 };
const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The connector record behind a catalog entry, or null when MERLIN has no connector for it. */
export function entryConnector(entry, connectors) {
  const id = entry?.integration?.type === 'native' ? entry.integration.connector : '';
  return (id && connectors.get(id)) || null;
}

export function statusKey(connector) { return STATUS[connector?.status] ? connector.status : 'not_connected'; }

export function relativeTime(iso, now = Date.now()) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return 'just now';
  const unit = (count, name) => `${count} ${name}${count === 1 ? '' : 's'} ago`;
  if (seconds < 3600) return unit(Math.max(1, Math.round(seconds / 60)), 'minute');
  if (seconds < 86_400) return unit(Math.round(seconds / 3600), 'hour');
  if (seconds < 86_400 * 30) return unit(Math.round(seconds / 86_400), 'day');
  return new Date(time).toLocaleDateString();
}

/** Label, tone and the exact sentence to show for a connector's status. */
export function statusInfo(connector, now = Date.now()) {
  const key = statusKey(connector);
  const base = STATUS[key];
  const verified = key === 'connected' && connector?.verified_at ? `Verified ${relativeTime(connector.verified_at, now)}.` : '';
  const detail = key === 'connected' ? [connector?.detail, verified].filter(Boolean).join(' ')
    : key === 'saved' ? (connector?.detail || 'Setup unfinished: your settings are saved but not verified, so MERLIN cannot use this yet.')
      : key === 'attention' ? (connector?.issue?.message || connector?.detail || 'MERLIN could not use the saved settings.')
        : connector?.detail || base.label;
  return { key, ...base, detail, issue: key === 'connected' && connector?.issue?.message ? connector.issue.message : '' };
}

/** Catalog ids (and 'spotify') whose connector is verified connected right now. */
export function connectedEntryIds(entries, connectors) {
  return new Set(entries.filter(entry => entryConnector(entry, connectors)?.status === 'connected' || (entry.external && connectors.get(entry.id)?.status === 'connected')).map(entry => entry.id));
}

/** Real connectors first, then guides, then dead ends; otherwise keep the catalog order. */
export function sortEntries(entries) {
  return entries.map((entry, index) => ({ entry, index }))
    .sort((a, b) => (RANK[a.entry.integration?.type] ?? 3) - (RANK[b.entry.integration?.type] ?? 3) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** The same filters searchConnections applies, for the one entry that is not in the catalog. */
export function entryMatches(entry, { query = '', category = 'all', company = 'all', difficulty = 'all', view = 'all', connectedIds = new Set(), categoryLabels = new Map() } = {}) {
  if (normalize(category) !== 'all' && !entry.categoryIds.includes(normalize(category))) return false;
  if (normalize(company) !== 'all' && normalize(entry.company) !== normalize(company)) return false;
  if (normalize(difficulty) !== 'all' && entry.difficulty !== normalize(difficulty)) return false;
  if (normalize(view) === 'connected' && !connectedIds.has(entry.id)) return false;
  const text = normalize([entry.name, entry.company, ...(entry.aliases ?? []), entry.description, ...entry.categoryIds.map(id => categoryLabels.get(id))].join(' '));
  return normalize(query).split(' ').filter(Boolean).every(token => text.includes(token));
}

/** What a field needs from the person right now. A saved secret never needs retyping. */
export function fieldState(connector, field) {
  const saved = field.type === 'secret' && (connector?.secrets_saved ?? []).includes(field.name);
  const current = field.type === 'secret' ? '' : String(connector?.values?.[field.name] ?? '');
  return { saved, current, required: field.required !== false && !saved && !current };
}

/**
 * The request body for connect: only fields this connector declares, only non-blank strings, trimmed.
 * Blank fields are omitted so the server keeps a saved secret. Anything else in `entered` is dropped.
 */
export function formPayload(connector, entered) {
  const body = {};
  for (const field of connector?.fields ?? []) {
    const value = entered?.[field.name];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) body[field.name] = trimmed;
  }
  return body;
}

/** Fields that must be filled before the form can be sent. */
export function missingFields(connector, entered) {
  const body = formPayload(connector, entered);
  return (connector?.fields ?? []).filter(field => fieldState(connector, field).required && !body[field.name]).map(field => field.label);
}

/** Whether an extra setup step is usable now, and why not. */
export function operationState(connector, operation) {
  const status = statusKey(connector);
  if (operation.needs === 'saved' && status === 'not_connected') return { enabled: false, reason: 'Save the settings above first.' };
  return { enabled: true, reason: '' };
}

/** "Find my bridge (asks Signify…)" becomes the button text and a visible privacy note. */
export function splitOperationLabel(label) {
  const match = String(label ?? '').match(/^(.*?)\s*\(([^)]*)\)\s*$/u);
  return match ? { text: match[1], note: `${match[2].charAt(0).toUpperCase()}${match[2].slice(1)}.` } : { text: String(label ?? ''), note: '' };
}

const VALUE_LABELS = { url: 'Address', name: 'Name', version: 'Version', bridge: 'Bridge address', devices: 'Devices found', controllers: 'Controllers found' };
/** Non-secret saved values worth showing as plain facts. Arrays and unknown keys are left out. */
export function valueFacts(connector) {
  return Object.entries(connector?.values ?? {})
    .filter(([key, value]) => VALUE_LABELS[key] && (typeof value === 'string' || typeof value === 'number') && String(value).trim() !== '')
    .map(([key, value]) => ({ label: VALUE_LABELS[key], value: String(value) }));
}

export function actionLabel(entry, connectors, live) {
  const connector = entryConnector(entry, connectors) ?? (entry.external ? connectors.get(entry.id) : null);
  if (live && (connector || entry.integration?.type === 'native')) {
    return { connected: 'Manage', saved: 'Finish setup', attention: 'Fix this' }[statusKey(connector)] ?? 'Set up';
  }
  return entry.integration?.type === 'none' ? 'Details' : 'Setup guide';
}

export function routeKind(entry) { return entry.integration?.type ?? 'none'; }

/** Server errors are `{error}`; anything else gets a calm, specific fallback. */
export function errorText(data, status) {
  if (data && typeof data.error === 'string' && data.error.trim()) return data.error.slice(0, 400);
  if (status === 401) return 'The service rejected the credentials.';
  if (status === 429) return 'The service is rate limiting requests. Try again shortly.';
  return 'That did not work. Check the details and try again.';
}
