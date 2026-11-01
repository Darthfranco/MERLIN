/* Data and actions for the connection touchscreen. Pure functions: the page owns the network,
   the 3D screen owns the drawing (assets/merlin-character/viewer/panels/connections.js).

   Everything shown here is real status. A service looks connected only when the server's connector hub
   says it is connected and verified; saved settings, guides and unsupported services never do. The
   screen never asks for a token, password or key: credentials are typed on the Connection Center page,
   which the "Set up" buttons open in a normal browser tab. Spotify keeps its own setup page. */
// Relative on purpose: the page resolves it to /connections/catalog.js and Node resolves the same file in tests.
import {CATEGORIES, CONNECTIONS, searchConnections} from '../connections/catalog.js';
import {SPOTIFY_INTEGRATION} from '../connections/integrations.js';

export const SPOTIFY = Object.freeze({
  id: 'spotify', name: 'Spotify', company: 'Spotify', categoryIds: ['music'], real: true, difficulty: 'easy', availability: 'standard',
  method: 'Your Spotify developer app', difficultyReason: 'Easy once you have a Spotify Premium account and your own free developer app.',
  requirements: ['A Spotify Premium account', 'A free Spotify developer app and its Client ID', 'Spotify open on a speaker or phone'],
  steps: [{title: 'Open Spotify setup'}, {title: 'Paste your Client ID and connect'}, {title: 'Choose a playback device'}],
  limitations: ['Music works by typing or on the music panel, not by voice.'],
  guideUrl: 'https://developer.spotify.com/documentation/web-api/concepts/apps', setupUrl: '/#spotify-title',
  integration: SPOTIFY_INTEGRATION,
});

const CURATED = ['all', 'lights', 'cameras', 'climate', 'appliances', 'locks', 'music', 'hubs'];
const LABELS = new Map([['all', 'All'], ['music', 'Music'], ...CATEGORIES.map(({id, label}) => [id, label.replace('Cameras & doorbells', 'Cameras').replace('Heating & cooling', 'Climate').replace('Plugs & switches', 'Plugs').replace('Hubs & platforms', 'Hubs').replace('Robot vacuums', 'Vacuums').replace('Energy & charging', 'Energy').replace('Blinds & curtains', 'Blinds').replace('TVs & streaming', 'TVs')])]);
const RANK = {easy: 0, medium: 1, hard: 2};
const route = id => id === SPOTIFY.id ? SPOTIFY : CONNECTIONS.find(entry => entry.id === id) || null;
const isNative = entry => entry?.integration?.type === 'native';

export function initialUi(card = {}) {
  const entry = route(card.entry) ? card.entry : null;
  const category = card.category === 'all' || LABELS.has(card.category) ? card.category || 'all' : 'all';
  return {view: entry ? 'setup' : 'browse', category, entryId: entry, query: typeof card.query === 'string' ? card.query.slice(0, 80) : '', page: 0, notice: '', announce: '', confirm: '', busy: ''};
}

export function chipCategories(active) {
  const ids = CURATED.includes(active) ? CURATED : [...CURATED.slice(0, -1), active];
  return ids.map(id => ({id, label: LABELS.get(id) || id, active: id === active}));
}

// ---- real status --------------------------------------------------------------------------------------------------

/**
 * connected    verified by the service itself          saved        settings stored, setup unfinished
 * attention    credentials rejected or a check failed  available    can be set up on the Connection Center
 * unavailable  cannot run here                         guide        only works through Home Assistant
 * none         MERLIN has no supported route
 */
function statusOf(entry, {connectors = [], spotify = {}}) {
  if (!isNative(entry)) return entry.integration?.type === 'via-home-assistant' ? 'guide' : 'none';
  const hub = connectors.find(connector => connector.id === (entry.real ? 'spotify' : entry.integration.connector));
  if (hub) return hub.status === 'not_connected' ? 'available' : ['connected', 'saved', 'attention', 'unavailable'].includes(hub.status) ? hub.status : 'available';
  // Before the server has answered, Spotify's own live status is still real.
  if (entry.real) return spotify.connected === true ? 'connected' : spotify.configured === true ? 'saved' : 'available';
  return 'available';
}
const hubOf = (entry, {connectors = []}) => connectors.find(connector => connector.id === (entry.real ? 'spotify' : entry.integration?.connector));

const SUMMARY = {
  connected: 'Connected and verified.', saved: 'Setup unfinished. MERLIN can’t use it yet.', available: 'Not connected yet.',
};
function liveSummary(status, hub) {
  if (status === 'attention') return hub?.detail || 'Needs attention. Check the saved connection.';
  if (status === 'unavailable') return hub?.detail || 'Unavailable right now.';
  return SUMMARY[status] || '';
}

const LIVE = new Set(['connected', 'attention', 'saved']);
function rankOf(entry, status) {
  if (LIVE.has(status)) return 0;
  if (isNative(entry)) return 1;
  return entry.difficulty === 'easy' ? 2 : 3;
}

function entriesFor(ui, context) {
  let entries;
  if (ui.category === 'music') entries = [SPOTIFY, ...searchConnections({category: 'speakers', query: ui.query})];
  else {
    entries = searchConnections({category: ui.category || 'all', query: ui.query});
    if (ui.category === 'all' && (!ui.query || /spotify|music/i.test(ui.query))) entries = [SPOTIFY, ...entries];
  }
  // Working and half-finished services first, then what can really be set up, then easy guides; catalog order otherwise.
  return entries.map((entry, index) => ({entry, index, rank: rankOf(entry, statusOf(entry, context))}))
    .sort((a, b) => a.rank - b.rank || RANK[a.entry.difficulty] - RANK[b.entry.difficulty] || a.index - b.index).map(({entry}) => entry);
}

/** The state the painter and tap layer draw from. */
export function panelState(ui, {connectors = [], spotify = {}} = {}) {
  const context = {connectors, spotify};
  const base = {type: 'connections', source: 'live', notice: ui.notice || '', categories: chipCategories(ui.category), page: ui.page || 0};
  const entry = ui.view === 'setup' ? route(ui.entryId) : null;
  if (entry) {
    const status = statusOf(entry, context), integration = entry.integration || {};
    return {...base, view: 'setup', setup: {
      id: entry.id, name: entry.name, company: entry.company, difficulty: entry.difficulty, real: Boolean(entry.real),
      type: integration.type || 'none', via: integration.via || '', status,
      summary: isNative(entry) ? liveSummary(status, hubOf(entry, context)) : entry.availabilityNote || entry.difficultyReason || '',
      requirements: entry.requirements || [], steps: (entry.steps || []).map(step => step.title), limitations: entry.limitations || [],
      afterwards: integration.afterwards || '', remaining: integration.remaining || '',
      guideUrl: entry.guideUrl || '', busy: ui.busy || '', confirmDisconnect: ui.confirm === entry.id,
    }};
  }
  return {...base, view: 'browse', tiles: entriesFor(ui, context).map(item => ({
    id: item.id, name: item.name, sub: item.company === item.name ? item.method : item.company, difficulty: item.difficulty, real: Boolean(item.real),
    type: item.integration?.type || 'none', status: statusOf(item, context),
  }))};
}

/**
 * Pure reducer for a tap. Returns the next UI state and, when the page must act, an effect:
 *   {type:'open', url}              open a page in a new tab (guides, the Connection Center, Spotify setup)
 *   {type:'verify'|'disconnect', id, name}   ask the server; only native services have either
 */
export function applyAction(ui, action, {pages = 1} = {}) {
  const next = patch => ({ui: {...ui, notice: '', announce: '', confirm: '', ...patch}});
  const target = () => route(action.value || ui.entryId);
  switch (action.action) {
    case 'category': return next({view: 'browse', category: LABELS.has(action.value) || action.value === 'all' ? action.value : 'all', query: '', entryId: null, page: 0});
    case 'page': return next({page: Math.min(Math.max(0, (ui.page || 0) + (action.value === -1 ? -1 : 1)), Math.max(0, pages - 1))});
    case 'open': return route(action.value) ? next({view: 'setup', entryId: action.value}) : {ui};
    case 'back': return next({view: 'browse', entryId: null});
    case 'setup': {
      // Credentials are typed on the Connection Center page, never on this screen.
      const entry = target();
      if (!isNative(entry)) return {ui};
      return {ui: {...ui, notice: '', announce: '', confirm: ''}, effect: {type: 'open', url: entry.real ? entry.setupUrl : `/connections/#${entry.id}`, name: entry.name}};
    }
    case 'verify': {
      const entry = target();
      return isNative(entry) && !entry.real ? {ui: {...ui, notice: '', announce: '', confirm: ''}, effect: {type: 'verify', id: entry.id, name: entry.name}} : {ui};
    }
    case 'disconnect': {
      const entry = target();
      if (!isNative(entry)) return {ui};
      // A second tap confirms, so a stray touch cannot remove a working connection.
      if (ui.confirm !== entry.id) return {ui: {...ui, confirm: entry.id, announce: '', notice: `Tap Disconnect again to remove ${entry.name} from MERLIN.`}};
      return {ui: {...ui, notice: '', announce: '', confirm: ''}, effect: {type: 'disconnect', id: entry.id, name: entry.name}};
    }
    case 'guide': {
      const url = route(ui.entryId)?.guideUrl;
      return url && /^https:\/\//u.test(url) ? {ui, effect: {type: 'open', url}} : {ui};
    }
    default: return {ui};
  }
}

export const connectionsPanelRecord = () => ({type: 'connections', id: 'connections', label: 'Connect your home', source: 'live'});
export const routeName = id => route(id)?.name || '';

/** The connector record the server returned, reduced to what this screen keeps. */
export const connectorSummary = item => ({id: item.id, name: item.name, status: item.status, detail: item.detail, verified_at: item.verified_at ?? null, external: Boolean(item.external)});
