import { CATEGORIES, CONNECTIONS, searchConnections } from './catalog.js';
import { icon } from './icons.js';
import {
  SPOTIFY_ENTRY, actionLabel, connectedEntryIds, entryConnector, entryMatches, errorText, fieldState, formPayload, missingFields,
  operationState, routeKind, sortEntries, splitOperationLabel, statusInfo, valueFacts,
} from './live.js';

// Live mode means MERLIN itself served this page, so /api/connectors is the one source of truth for what is connected.
// Anywhere else (npm run connections) the page is a read-only guide. Secrets are read from the form at submit time,
// cleared immediately, and never kept in script state, storage, the URL, or the console.
const live = document.documentElement.dataset.live === 'true';
const $ = id => document.getElementById(id);
const ENTRIES = [SPOTIFY_ENTRY, ...CONNECTIONS];
const byId = new Map(ENTRIES.map(item => [item.id, item]));
const categories = new Map(CATEGORIES.map(item => [item.id, item]));
const categoryLabels = new Map(CATEGORIES.map(item => [item.id, item.label]));
const MAIN_URL = 'http://127.0.0.1:3000/connections/';

let connectors = new Map();
let searchStatus = null;
let loadError = '';
let view = 'all';
let category = 'all';
let selectedId = null;
let listScroll = 0;
let returnFocusId = null;
let busy = null;
let confirming = null;
const messages = new Map();
const drafts = new Map();
const discoveries = new Map();
let toastTimer;
let announceTimer;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className, callback) {
  const node = el('button', className, text);
  node.type = 'button';
  if (callback) node.addEventListener('click', callback);
  return node;
}

function difficultyBadge(item) {
  return el('span', `difficulty ${item.difficulty}`, item.difficulty[0].toUpperCase() + item.difficulty.slice(1));
}

function categoryText(item) {
  return item.categoryIds.map(id => categories.get(id)?.label).filter(Boolean).join(' · ');
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
}

function connectorFor(item) {
  return item.external ? connectors.get(item.id) ?? null : entryConnector(item, connectors);
}

const statusBadge = info => {
  const node = el('span', `status-badge ${info.tone}`);
  node.append(icon(info.icon), document.createTextNode(info.label));
  return node;
};

const routeChip = item => el('span', `route-chip ${routeKind(item)}`, item.integration.label);

// ---- network ------------------------------------------------------------------------------------------------------

async function api(path, body) {
  let response;
  try {
    response = await fetch(path, body === undefined
      ? { headers: { Accept: 'application/json' } }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw new Error('MERLIN could not be reached. Check that it is running, then try again.'); }
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) throw new Error(errorText(data, response.status));
  return data;
}

function applyItem(item) {
  const { message, result, ...record } = item;
  connectors = new Map(connectors).set(record.id, record);
}

async function load() {
  if (!live) return;
  try {
    const data = await api('/api/connectors');
    connectors = new Map(data.connectors.map(item => [item.id, item]));
    searchStatus = data.search ?? null;
    loadError = '';
  } catch (error) { loadError = error.message; }
  renderChrome();
  renderList();
}

// ---- page chrome --------------------------------------------------------------------------------------------------

function renderChrome() {
  $('mode-label').textContent = live ? 'Real connections' : 'Setup guide';
  const text = $('mode-text');
  if (live) {
    text.textContent = 'Connected means MERLIN checked with the service itself and it answered. A guide never connects anything by itself.';
  } else {
    const link = el('a', '', MAIN_URL);
    link.href = MAIN_URL;
    text.replaceChildren(document.createTextNode('This is the setup guide. To connect real services, open MERLIN’s Connection Center at '), link, document.createTextNode('.'));
  }
  $('connected-view').hidden = !live;
  $('footer-note').textContent = live ? 'Credentials stay on this computer' : 'Setup guide · Nothing here connects to a device';
  $('load-notice').hidden = !loadError;
  $('load-notice').textContent = loadError ? `MERLIN’s connection status could not be loaded: ${loadError} Guides still work, but nothing can be connected until this loads.` : '';
  const status = $('search-status');
  status.hidden = !(live && searchStatus);
  if (live && searchStatus) {
    status.className = `search-status ${searchStatus.available ? 'ok' : 'off'}`;
    status.replaceChildren(icon(searchStatus.available ? 'check' : 'alert'), document.createTextNode(searchStatus.detail || (searchStatus.available ? 'Web search is available.' : 'Web search is unavailable.')));
  }
}

// ---- directory ----------------------------------------------------------------------------------------------------

function currentResults() {
  const filters = { query: $('search').value, category, company: $('company').value, difficulty: $('difficulty').value };
  const connectedIds = connectedEntryIds(ENTRIES, connectors);
  const catalog = searchConnections({ ...filters, connectedIds, view });
  const spotify = entryMatches(SPOTIFY_ENTRY, { ...filters, view, connectedIds, categoryLabels }) ? [SPOTIFY_ENTRY] : [];
  return { results: sortEntries([...spotify, ...catalog]), connectedIds };
}

function renderCategories(connectedIds) {
  const nodes = [{ id: 'all', label: 'All categories', icon: 'grid' }, ...CATEGORIES].map(item => {
    const count = ENTRIES.filter(connection => (view !== 'connected' || connectedIds.has(connection.id)) && (item.id === 'all' || connection.categoryIds.includes(item.id))).length;
    const node = button('', 'category-button', () => {
      category = item.id;
      $('category-mobile').value = category;
      renderList();
      document.getElementById(`category-${item.id}`)?.focus({ preventScroll: true });
    });
    node.id = `category-${item.id}`;
    node.setAttribute('aria-pressed', String(category === item.id));
    const countNode = el('span', 'category-count', String(count));
    countNode.setAttribute('aria-hidden', 'true');
    node.append(icon(item.icon), el('span', '', item.label), countNode);
    return node;
  });
  $('category-list').replaceChildren(...nodes);
}

function rowFor(item) {
  const connector = live ? connectorFor(item) : null;
  const row = el('article', 'connection-row');
  row.dataset.connectionId = item.id;
  const main = el('div', 'connection-main');
  const symbol = el('span', 'connection-icon');
  symbol.append(icon(categories.get(item.categoryIds[0])?.icon || 'hub'));
  const copy = el('div', 'connection-copy');
  const title = el('h3');
  const name = el('a', 'connection-name', item.name);
  name.href = `#setup/${item.id}`;
  name.id = `name-${item.id}`;
  name.addEventListener('click', () => { returnFocusId = name.id; });
  title.append(name);
  const meta = el('p', 'connection-meta');
  meta.append(routeChip(item));
  if (connector) meta.append(statusBadge(statusInfo(connector)));
  meta.append(el('span', '', categoryText(item)));
  if (item.availability === 'restricted') meta.append(el('span', 'availability-label', 'Limited access'));
  copy.append(title, el('p', 'connection-description', item.description), meta);
  main.append(symbol, copy);
  const difficulty = el('div', 'connection-difficulty');
  difficulty.append(difficultyBadge(item));
  const action = el('div', 'row-action');
  const label = actionLabel(item, connectors, live);
  const actionButton = button(label, connector?.status === 'connected' ? 'secondary connected' : 'secondary', () => {
    returnFocusId = `action-${item.id}`;
    location.hash = `setup/${item.id}`;
  });
  actionButton.id = `action-${item.id}`;
  actionButton.setAttribute('aria-label', `${label}: ${item.name}`);
  action.append(actionButton);
  row.append(main, difficulty, action);
  return row;
}

function renderList() {
  const filtersActive = Boolean($('search').value || category !== 'all' || $('company').value !== 'all' || $('difficulty').value !== 'all');
  const { results, connectedIds } = currentResults();
  $('connected-count').textContent = String(connectedIds.size);
  $('browse-view').toggleAttribute('aria-current', view === 'all');
  $('connected-view').toggleAttribute('aria-current', view === 'connected');
  (view === 'all' ? $('browse-view') : $('connected-view')).setAttribute('aria-current', 'page');
  $('page-title').textContent = view === 'connected' ? 'Your connections' : 'Connection center';
  $('page-subtitle').textContent = view === 'connected'
    ? 'Services MERLIN has verified with the service itself.'
    : 'Connect the services MERLIN can really control, and read honest setup guides for the rest.';
  $('results-heading').firstChild.textContent = category !== 'all' ? `${categories.get(category).label} ` : view === 'connected' ? 'Connected ' : 'All connections ';
  $('results-count').textContent = `${results.length}`;
  $('reset-filters').hidden = !filtersActive;
  $('clear-search').hidden = !$('search').value;
  renderCategories(connectedIds);
  $('connection-list').replaceChildren(...results.map(rowFor));
  $('empty-state').hidden = results.length !== 0;
  document.querySelector('.list-head').hidden = results.length === 0;
  if (!results.length) {
    const none = view === 'connected' && !filtersActive;
    $('empty-icon').replaceChildren(icon(none ? 'plug' : 'search'));
    $('empty-title').textContent = none ? 'Nothing is connected yet' : 'No matching connections';
    $('empty-description').textContent = none
      ? 'Set up a service marked “Connects to MERLIN”. A guide never counts as a connection.'
      : 'Try another company or device, or reset your filters to see more options.';
    $('empty-action').textContent = none ? 'Browse connections' : 'Reset filters';
    $('empty-action').onclick = () => none ? changeView('all') : resetFilters();
  }
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { $('results-announcement').textContent = `${results.length} ${results.length === 1 ? 'connection' : 'connections'} shown.`; }, 180);
}

function resetFilters() {
  $('search').value = '';
  $('company').value = 'all';
  $('difficulty').value = 'all';
  $('category-mobile').value = 'all';
  category = 'all';
  renderList();
  $('search').focus();
}

function changeView(next) {
  view = next;
  resetFilters();
  if (selectedId) {
    listScroll = 0;
    returnFocusId = next === 'all' ? 'browse-view' : 'connected-view';
    location.hash = '';
  } else {
    window.scrollTo(0, 0);
    $(next === 'all' ? 'browse-view' : 'connected-view').focus({ preventScroll: true });
  }
}

// ---- setup view ---------------------------------------------------------------------------------------------------

function list(tag, className, items) {
  const node = el(tag, className);
  node.append(...items.map(text => el('li', '', text)));
  return node;
}

const safeLocalPath = value => (typeof value === 'string' && /^\/(?!\/)[\w#/?=&.-]*$/u.test(value) ? value : '/');

function setDraft(id, name, value) {
  drafts.set(id, { ...(drafts.get(id) ?? {}), [name]: value });
}

function formIsDirty() {
  const panel = $('live-panel');
  if (!panel) return false;
  const typing = panel.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName);
  return typing || [...panel.querySelectorAll('input[type="password"]')].some(input => input.value);
}

async function runStep(item, step, body = {}, focusId = 'status-region') {
  const connector = connectorFor(item);
  if (busy || !connector) return;
  busy = { id: item.id, step };
  confirming = null;
  messages.delete(item.id);
  refreshLive(item);
  try {
    const result = await api(`/api/connectors/${item.id}/${step}`, body);
    applyItem(result);
    if (Array.isArray(result.result)) discoveries.set(item.id, result.result.slice(0, 5));
    else discoveries.delete(item.id);
    if (step === 'connect') drafts.delete(item.id);
    messages.set(item.id, { kind: 'ok', text: result.message || 'Done.' });
    if (step === 'disconnect') toast(result.message || `Disconnected ${item.name}.`);
  } catch (error) {
    messages.set(item.id, { kind: 'error', text: error.message });
    focusId = 'message-region';
    await load();
  } finally {
    busy = null;
    refreshLive(item, focusId);
    renderList();
    renderChrome();
  }
}

function field(item, connector, definition) {
  const state = fieldState(connector, definition);
  const id = `field-${item.id}-${definition.name}`;
  const wrap = el('div', 'field');
  const label = el('label', '', `${definition.label}${state.saved ? ' (saved)' : definition.required === false ? ' (optional)' : ''}`);
  label.htmlFor = id;
  const input = el('input');
  input.id = id;
  input.name = definition.name;
  input.type = definition.type === 'secret' ? 'password' : 'text';
  input.autocomplete = 'off';
  input.autocapitalize = 'off';
  input.spellcheck = false;
  if (definition.type === 'url') input.inputMode = 'url';
  input.required = state.required;
  input.placeholder = state.saved ? 'Saved on this computer. Leave blank to keep it.' : definition.placeholder || '';
  if (definition.type !== 'secret') input.value = drafts.get(item.id)?.[definition.name] ?? state.current;
  if (definition.type !== 'secret') input.addEventListener('input', () => setDraft(item.id, definition.name, input.value));
  wrap.append(label, input);
  if (definition.help) {
    const help = el('p', 'field-help', definition.help);
    help.id = `${id}-help`;
    input.setAttribute('aria-describedby', help.id);
    wrap.append(help);
  }
  return wrap;
}

function buildLivePanel(item) {
  const connector = connectorFor(item);
  const panel = el('section', 'connect-panel');
  panel.id = 'live-panel';
  panel.setAttribute('aria-labelledby', 'connect-heading');
  const heading = el('h2', '', item.external ? `${item.name} connection` : `Connect ${item.name}`);
  heading.id = 'connect-heading';
  panel.append(heading);
  if (!connector) {
    panel.append(el('p', 'inline-alert', loadError ? 'MERLIN’s status could not be loaded, so this service cannot be connected right now.' : 'MERLIN is not reporting this service. Restart MERLIN and reload this page.'));
    return panel;
  }
  const info = statusInfo(connector);
  const working = busy?.id === item.id;
  panel.setAttribute('aria-busy', String(working));

  const statusBox = el('div', `status-box ${info.tone}`);
  statusBox.id = 'status-region';
  statusBox.tabIndex = -1;
  statusBox.setAttribute('role', 'status');
  statusBox.setAttribute('aria-live', 'polite');
  statusBox.append(statusBadge(info), el('p', 'status-detail', working ? `Checking with ${item.name}…` : info.detail));
  if (info.issue && !working) statusBox.append(el('p', 'status-issue', `Last problem: ${info.issue}`));
  panel.append(statusBox);

  const message = messages.get(item.id);
  const messageBox = el('div', message?.kind === 'error' ? 'inline-alert' : 'inline-note', message?.text ?? '');
  messageBox.id = 'message-region';
  messageBox.tabIndex = -1;
  messageBox.setAttribute('role', message?.kind === 'error' ? 'alert' : 'status');
  messageBox.hidden = !message;
  panel.append(messageBox);

  const facts = valueFacts(connector);
  if (facts.length && connector.status !== 'not_connected') {
    const dl = el('dl', 'fact-list');
    facts.forEach(fact => dl.append(el('dt', '', fact.label), el('dd', '', fact.value)));
    panel.append(dl);
  }

  if (item.external) {
    const actions = el('div', 'form-actions');
    const link = el('a', 'button-link', connector.status === 'connected' ? 'Open Spotify controls' : 'Open Spotify setup');
    link.href = safeLocalPath(connector.setup_url);
    actions.append(link);
    panel.append(el('p', 'field-help', 'Spotify is set up on the main MERLIN page, where you paste your Client ID and approve access on Spotify’s own site.'), actions);
    if (connector.status !== 'not_connected') {
      const row = el('div', 'form-actions secondary-actions');
      const confirm = disconnectControl(row, item, working, 'Disconnect');
      panel.append(row);
      if (confirm) panel.append(confirm);
    }
    return panel;
  }

  const form = el('form', 'connect-form');
  form.noValidate = true;
  form.autocomplete = 'off';
  form.setAttribute('aria-label', `${item.name} settings`);
  connector.fields.forEach(definition => form.append(field(item, connector, definition)));
  const submit = el('button', '', connector.status === 'connected' ? 'Check and update' : 'Check and connect');
  submit.type = 'submit';
  submit.id = 'connect-submit';
  submit.disabled = working;
  const actions = el('div', 'form-actions');
  actions.append(submit);
  form.append(actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    const entered = Object.fromEntries(connector.fields.map(definition => [definition.name, form.elements[definition.name]?.value ?? '']));
    // Secrets leave the form before anything else happens.
    connector.fields.filter(definition => definition.type === 'secret').forEach(definition => { form.elements[definition.name].value = ''; });
    const missing = missingFields(connector, entered);
    if (missing.length) {
      messages.set(item.id, { kind: 'error', text: `Enter ${missing.join(' and ')} first.` });
      refreshLive(item, 'message-region');
      return;
    }
    runStep(item, 'connect', formPayload(connector, entered), 'status-region');
  });
  panel.append(form);

  // Removing one device is offered next to each device below, never as a bare button.
  const ops = connector.operations.filter(operation => operation.name !== 'remove');
  if (ops.length) {
    const row = el('div', 'op-row');
    for (const operation of ops) {
      const { text, note } = splitOperationLabel(operation.label);
      const state = operationState(connector, operation);
      const primary = operation.needs === 'saved' && connector.status === 'saved';
      const node = button(text, primary ? '' : 'secondary', () => runStep(item, operation.name, {}, `op-${operation.name}`));
      node.id = `op-${operation.name}`;
      node.disabled = working || !state.enabled;
      const hint = [note, state.reason].filter(Boolean).join(' ');
      if (hint) {
        const noteNode = el('p', 'field-help', hint);
        noteNode.id = `op-${operation.name}-note`;
        node.setAttribute('aria-describedby', noteNode.id);
        const group = el('div', 'op');
        group.append(node, noteNode);
        row.append(group);
      } else row.append(node);
    }
    panel.append(row);
  }

  const found = discoveries.get(item.id);
  if (found) {
    const group = el('div', 'discover');
    group.append(el('h3', '', found.length ? 'Found on your network' : 'Nothing answered'));
    if (found.length) {
      const items = el('ul', 'device-list');
      for (const bridge of found) {
        const entry = el('li');
        entry.append(el('span', '', bridge.ip));
        const use = button('Use this address', 'secondary', () => {
          const first = connector.fields.find(definition => definition.type !== 'secret');
          if (first) { setDraft(item.id, first.name, bridge.ip); discoveries.delete(item.id); refreshLive(item, `field-${item.id}-${first.name}`); }
        });
        use.setAttribute('aria-label', `Use address ${bridge.ip}`);
        entry.append(use);
        items.append(entry);
      }
      group.append(items);
    } else group.append(el('p', 'field-help', 'No bridge answered. Enter its address yourself.'));
    panel.append(group);
  }

  const devices = connector.values?.devices;
  if (Array.isArray(devices) && devices.length && connector.operations.some(operation => operation.name === 'remove')) {
    const group = el('div', 'discover');
    group.append(el('h3', '', 'Added devices'));
    const items = el('ul', 'device-list');
    for (const device of devices) {
      const entry = el('li');
      const label = el('span', '', device.name || device.model || 'Shelly');
      label.append(el('small', '', device.host));
      entry.append(label);
      const remove = button('Remove', 'secondary danger', () => runStep(item, 'remove', { host: device.host }, 'status-region'));
      remove.setAttribute('aria-label', `Remove ${device.name || device.model || 'device'} at ${device.host}`);
      remove.disabled = working || devices.length < 2;
      entry.append(remove);
      items.append(entry);
    }
    group.append(items);
    if (devices.length < 2) group.append(el('p', 'field-help', 'To remove the last one, use Disconnect.'));
    panel.append(group);
  }

  const secondary = el('div', 'form-actions secondary-actions');
  if (['connected', 'attention'].includes(connector.status)) {
    const verify = button('Check again', 'secondary', () => runStep(item, 'verify', {}, 'status-region'));
    verify.id = 'verify-button';
    verify.disabled = working;
    secondary.append(verify);
  }
  const confirm = connector.status !== 'not_connected' ? disconnectControl(secondary, item, working, connector.status === 'saved' ? 'Remove saved settings' : 'Disconnect') : null;
  if (secondary.childElementCount) panel.append(secondary);
  if (confirm) panel.append(confirm);
  return panel;
}

/** Adds the Disconnect button to `row`, or returns the in-page confirmation once it has been asked for. */
function disconnectControl(row, item, working, label) {
  if (confirming !== item.id) {
    const disconnect = button(label, 'secondary danger', () => { confirming = item.id; refreshLive(item); });
    disconnect.id = 'disconnect-button';
    disconnect.disabled = working;
    row.append(disconnect);
    return null;
  }
  const box = el('div', 'confirm-box');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-labelledby', 'confirm-title');
  const title = el('p', '', `${label === 'Disconnect' ? `Disconnect ${item.name}?` : `Remove ${item.name}’s saved settings?`} MERLIN will forget its saved settings and stop using it. The service may also need access removed on its side; MERLIN will say so afterward.`);
  title.id = 'confirm-title';
  const yes = button(label, 'secondary danger', () => runStep(item, 'disconnect', {}, 'status-region'));
  yes.id = 'confirm-disconnect';
  const no = button('Keep it', 'secondary', () => { confirming = null; refreshLive(item, 'disconnect-button'); });
  no.id = 'cancel-disconnect';
  const buttons = el('div', 'form-actions');
  buttons.append(yes, no);
  box.append(title, buttons);
  queueMicrotask(() => $('cancel-disconnect')?.focus({ preventScroll: true }));
  return box;
}

function refreshLive(item, focusId) {
  if (selectedId !== item.id || !$('live-panel')) return;
  $('live-panel').replaceWith(buildLivePanel(item));
  if (focusId) (document.getElementById(focusId) || $('status-region'))?.focus({ preventScroll: true });
}

function appendGuide(guide, item) {
  const type = routeKind(item);
  if (item.availabilityNote) guide.append(el('p', 'availability-note', item.availabilityNote));
  guide.append(el('h3', '', 'Before you start'), list('ul', 'requirements', item.requirements));
  const steps = el('ol', 'setup-steps');
  item.steps.forEach(step => {
    const entry = el('li');
    const body = el('div');
    body.append(el('h3', '', step.title), el('p', '', step.body));
    entry.append(body);
    steps.append(entry);
  });
  guide.append(steps);
  if (item.limitations.length) guide.append(el('h3', '', 'Good to know'), list('ul', 'limitations', item.limitations));
  const link = el('a', 'guide-link', type === 'none' ? 'Open the reference page' : 'Open the official setup reference');
  link.href = item.guideUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.append(icon('external'));
  guide.append(link);
}

function homeAssistantNote(item) {
  const note = el('div', 'route-note');
  note.setAttribute('role', 'note');
  const ha = connectors.get('home-assistant');
  const haInfo = live && ha ? statusInfo(ha) : null;
  const nothingYet = Array.isArray(item.integration.can) && item.integration.can.length === 0;
  if (nothingYet) {
    note.append(el('h3', '', 'MERLIN cannot control this yet'));
    note.append(el('p', '', `Home Assistant is the only route, and it does not let MERLIN control ${item.name} today. This guide does not connect MERLIN to ${item.name}; it only helps you set it up in Home Assistant for its own use.`));
    return note;
  }
  note.append(el('h3', '', 'Connect Home Assistant first'));
  note.append(el('p', '', `This guide does not connect MERLIN to ${item.name} by itself. MERLIN reaches it only through Home Assistant: get ${item.name} working in Home Assistant, then connect Home Assistant to MERLIN.`));
  if (haInfo) {
    const line = el('p', 'route-note-status');
    line.append(document.createTextNode('Home Assistant in MERLIN right now: '), statusBadge(haInfo));
    note.append(line);
  }
  const link = el('a', 'button-link secondary-link', 'Go to the Home Assistant card');
  link.href = '#setup/home-assistant';
  note.append(link);
  return note;
}

function renderSetup(item) {
  const container = $('setup');
  const back = button('Back to connections', 'text-button back-button', () => { location.hash = ''; });
  back.prepend(icon('back'));
  const type = routeKind(item);
  const layout = el('div', 'setup-layout');
  const summary = el('div', 'setup-summary');
  const symbol = el('span', 'setup-symbol');
  symbol.append(icon(categories.get(item.categoryIds[0])?.icon || 'hub'));
  const title = el('h1', '', item.name);
  title.id = 'setup-title';
  title.tabIndex = -1;
  const rating = el('div', 'setup-rating');
  rating.append(difficultyBadge(item), el('span', '', 'Setup difficulty'));
  const info = el('dl');
  info.append(el('dt', '', 'Company'), el('dd', '', item.company), el('dt', '', 'Categories'), el('dd', '', categoryText(item)), el('dt', '', 'Route'), el('dd', '', item.method));
  const chips = el('p', 'setup-route');
  chips.append(routeChip(item));
  summary.append(symbol, title, chips, el('p', '', item.description), rating, el('p', 'difficulty-reason', item.difficultyReason), info);

  const guide = el('div', 'setup-guide');
  const real = type === 'native' || item.external;
  if (real && live) guide.append(buildLivePanel(item));
  const heading = el('h2', '', type === 'native' || item.external ? 'How to connect' : type === 'none' ? 'No supported route' : 'Setup guide');
  guide.append(heading);
  guide.append(el('p', 'guide-intro', real
    ? (live ? 'The steps below get you what the form above needs.' : 'This page only shows the steps. To connect for real, open MERLIN’s Connection Center.')
    : type === 'none' ? 'MERLIN cannot control this today. This page says why, so you know what to expect.'
      : 'A guide for setting this up yourself. Following it does not connect MERLIN.'));
  if (type === 'via-home-assistant') guide.append(homeAssistantNote(item));
  const outcome = el('div', 'outcome');
  outcome.append(el('h3', '', 'What MERLIN can do afterward'), el('p', '', item.integration.afterwards), el('h3', '', 'What is still missing'), el('p', '', item.integration.remaining));
  guide.append(outcome);
  appendGuide(guide, item);
  layout.append(summary, guide);
  container.replaceChildren(back, layout);
}

function route() {
  // `#setup/<id>` is what the page writes; a bare `#<id>` is how the big screen links to a service.
  const raw = location.hash.slice(1);
  const id = raw.startsWith('setup/') ? raw.slice(6) : raw || null;
  const item = byId.get(id);
  if (item) {
    if (!selectedId) listScroll = window.scrollY;
    selectedId = id;
    confirming = null;
    $('directory').hidden = true;
    $('setup').hidden = false;
    renderSetup(item);
    document.title = `${item.name} setup · MERLIN`;
    window.scrollTo(0, 0);
    $('setup-title').focus({ preventScroll: true });
    // Always show what the service says now, not what it said when the page opened.
    load().then(() => { if (selectedId === item.id && !busy && !formIsDirty()) refreshLive(item); });
  } else {
    const wasDetail = Boolean(selectedId);
    selectedId = null;
    $('setup').hidden = true;
    $('directory').hidden = false;
    document.title = 'Connection center · MERLIN';
    renderList();
    if (wasDetail) {
      window.scrollTo(0, listScroll);
      (document.getElementById(returnFocusId) || $('search')).focus({ preventScroll: true });
    }
  }
}

$('search-icon').append(icon('search'));
$('clear-search').append(icon('close'));
const companies = [...new Set(ENTRIES.map(item => item.company))].sort((a, b) => a.localeCompare(b));
companies.forEach(company => { const option = el('option', '', company); option.value = company; $('company').append(option); });
CATEGORIES.forEach(entry => { const option = el('option', '', entry.label); option.value = entry.id; $('category-mobile').append(option); });
$('search').addEventListener('input', renderList);
$('company').addEventListener('change', renderList);
$('difficulty').addEventListener('change', renderList);
$('category-mobile').addEventListener('change', () => { category = $('category-mobile').value; renderList(); });
$('reset-filters').addEventListener('click', resetFilters);
$('clear-search').addEventListener('click', () => { $('search').value = ''; renderList(); $('search').focus(); });
$('browse-view').addEventListener('click', () => changeView('all'));
$('connected-view').addEventListener('click', () => changeView('connected'));
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); changeView('all'); });
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !live) return;
  load().then(() => { const item = selectedId && byId.get(selectedId); if (item && !busy && !formIsDirty()) refreshLive(item); });
});
renderChrome();
route();
if (!selectedId) load();
