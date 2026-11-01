/* Data and actions for the connection touchscreen. Pure functions: the page owns the network,
   the 3D screen owns the drawing (assets/merlin-character/viewer/panels/connections.js).

   Everything here is a preview, as in the Connection Center: a connection records a household
   choice and never authenticates, discovers, or controls anything. Spotify is the exception only
   in what it reports: its real status comes from the Spotify service and its setup stays on the
   existing Spotify page. */
// Relative on purpose: the page resolves it to /connections/catalog.js and Node resolves the same file in tests.
import {CATEGORIES, CONNECTIONS, searchConnections} from '../connections/catalog.js';

export const SPOTIFY = Object.freeze({
  id: 'spotify', name: 'Spotify', company: 'Spotify', categoryIds: ['music'], real: true, difficulty: 'easy', availability: 'standard',
  method: 'Your Spotify developer app', difficultyReason: 'Easy once you have a Spotify Premium account and your own free developer app.',
  requirements: ['A Spotify Premium account', 'A free Spotify developer app and its Client ID', 'Spotify open on a speaker or phone'],
  steps: [{title: 'Open Spotify setup'}, {title: 'Paste your Client ID and connect'}, {title: 'Choose a playback device'}],
  limitations: ['Music works by typing or on the music panel, not by voice.'],
  guideUrl: 'https://developer.spotify.com/documentation/web-api/concepts/apps', setupUrl: '/#spotify-title',
});

const CURATED = ['all', 'lights', 'cameras', 'climate', 'appliances', 'locks', 'music', 'hubs'];
const LABELS = new Map([['all', 'All'], ['music', 'Music'], ...CATEGORIES.map(({id, label}) => [id, label.replace('Cameras & doorbells', 'Cameras').replace('Heating & cooling', 'Climate').replace('Plugs & switches', 'Plugs').replace('Hubs & platforms', 'Hubs').replace('Robot vacuums', 'Vacuums').replace('Energy & charging', 'Energy').replace('Blinds & curtains', 'Blinds').replace('TVs & streaming', 'TVs')])]);
const RANK = {easy: 0, medium: 1, hard: 2};
const route = id => id === SPOTIFY.id ? SPOTIFY : CONNECTIONS.find(entry => entry.id === id) || null;

export function initialUi(card = {}) {
  const entry = route(card.entry) ? card.entry : null;
  const category = card.category === 'all' || LABELS.has(card.category) ? card.category || 'all' : 'all';
  return {view: entry ? 'setup' : 'browse', category, entryId: entry, query: typeof card.query === 'string' ? card.query.slice(0, 80) : '', page: 0, notice: ''};
}

export function chipCategories(active) {
  const ids = CURATED.includes(active) ? CURATED : [...CURATED.slice(0, -1), active];
  return ids.map(id => ({id, label: LABELS.get(id) || id, active: id === active}));
}

function entriesFor(ui) {
  let entries;
  if (ui.category === 'music') entries = [SPOTIFY, ...searchConnections({category: 'speakers', query: ui.query})];
  else {
    entries = searchConnections({category: ui.category || 'all', query: ui.query});
    if (ui.category === 'all' && (!ui.query || /spotify|music/i.test(ui.query))) entries = [SPOTIFY, ...entries];
  }
  // Easy routes first, because they are the quickest to try; catalog order otherwise.
  return entries.map((entry, index) => ({entry, index})).sort((a, b) => RANK[a.entry.difficulty] - RANK[b.entry.difficulty] || a.index - b.index).map(({entry}) => entry);
}

function connectedState(entry, {connectedIds = [], spotifyConnected = false}) {
  return entry.real ? spotifyConnected : connectedIds.includes(entry.id);
}

/** The state the painter and tap layer draw from. */
export function panelState(ui, {connectedIds = [], spotifyConnected = false} = {}) {
  const context = {connectedIds, spotifyConnected};
  const base = {type: 'connections', source: 'live', notice: ui.notice || '', categories: chipCategories(ui.category), page: ui.page || 0};
  const entry = ui.view === 'setup' ? route(ui.entryId) : null;
  if (entry) {
    const connected = connectedState(entry, context), available = entry.availability !== 'restricted';
    return {...base, view: 'setup', setup: {
      id: entry.id, name: entry.name, company: entry.company, difficulty: entry.difficulty, reason: entry.availabilityNote || entry.difficultyReason || '',
      requirements: entry.requirements || [], steps: (entry.steps || []).map(step => step.title), limitations: entry.limitations || [],
      available, connected, real: Boolean(entry.real), disconnectable: !entry.real && connected, guideUrl: entry.guideUrl || '',
    }};
  }
  return {...base, view: 'browse', tiles: entriesFor(ui).map(entry => ({
    id: entry.id, name: entry.name, sub: entry.company === entry.name ? entry.method : entry.company, difficulty: entry.difficulty, real: Boolean(entry.real),
    status: connectedState(entry, context) ? 'connected' : entry.availability === 'restricted' ? 'unavailable' : 'available',
  }))};
}

/**
 * Pure reducer for a tap. Returns the next UI state and, when the page must act, an effect:
 *   {type:'connect'|'disconnect', id}  or  {type:'open', url}
 */
export function applyAction(ui, action, {pages = 1} = {}) {
  const next = patch => ({ui: {...ui, notice: '', ...patch}});
  switch (action.action) {
    case 'category': return next({view: 'browse', category: LABELS.has(action.value) || action.value === 'all' ? action.value : 'all', query: '', entryId: null, page: 0});
    case 'page': return next({page: Math.min(Math.max(0, (ui.page || 0) + (action.value === -1 ? -1 : 1)), Math.max(0, pages - 1))});
    case 'open': return route(action.value) ? next({view: 'setup', entryId: action.value}) : {ui};
    case 'back': return next({view: 'browse', entryId: null});
    case 'connect': {
      const entry = route(action.value || ui.entryId);
      if (!entry) return {ui};
      return entry.real ? {ui: {...ui, notice: 'Spotify opens in the music setup page.'}, effect: {type: 'open', url: entry.setupUrl}}
        : {ui: {...ui, notice: ''}, effect: {type: 'connect', id: entry.id, name: entry.name}};
    }
    case 'disconnect': {
      const entry = route(action.value || ui.entryId);
      return entry && !entry.real ? {ui, effect: {type: 'disconnect', id: entry.id, name: entry.name}} : {ui};
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
