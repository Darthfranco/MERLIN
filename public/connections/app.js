import { CATEGORIES, CONNECTIONS, searchConnections } from './catalog.js';
import { icon } from './icons.js';
import { STORAGE_KEY, readConnections, writeConnections } from './state.js';

const $ = id => document.getElementById(id);
const allowedIds = CONNECTIONS.map(item => item.id);
const byId = new Map(CONNECTIONS.map(item => [item.id, item]));
const categories = new Map(CATEGORIES.map(item => [item.id, item]));
let storage;
try { storage = window.localStorage; } catch { storage = null; }
const saved = readConnections(storage, allowedIds);
let connected = saved.ids;
let view = 'all';
let category = 'all';
let selectedId = null;
let listScroll = 0;
let returnFocusId = null;
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
  node.addEventListener('click', callback);
  return node;
}

function difficultyBadge(item) {
  return el('span', `difficulty ${item.difficulty}`, item.difficulty[0].toUpperCase() + item.difficulty.slice(1));
}

function categoryText(item) {
  return item.categoryIds.map(id => categories.get(id)?.label).filter(Boolean).join(' · ');
}

function showStorageWarning(message) {
  $('storage-warning').textContent = message || '';
  $('storage-warning').hidden = !message;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

function persist() {
  showStorageWarning(writeConnections(storage, connected, allowedIds));
}

function connect(item) {
  connected.add(item.id);
  persist();
  renderList();
  if (selectedId) renderSetup(item, true);
  else document.getElementById(`action-${item.id}`)?.focus({ preventScroll: true });
  toast(`${item.name} connected in demo mode.`);
}

function disconnect(item) {
  connected.delete(item.id);
  persist();
  renderList();
  if (selectedId) renderSetup(item, true);
  toast(`${item.name} demo connection removed.`);
}

function renderCategories() {
  const nodes = [{ id: 'all', label: 'All categories', icon: 'grid' }, ...CATEGORIES].map(item => {
    const count = CONNECTIONS.filter(connection => (view !== 'connected' || connected.has(connection.id)) && (item.id === 'all' || connection.categoryIds.includes(item.id))).length;
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

function renderList() {
  const filtersActive = Boolean($('search').value || category !== 'all' || $('company').value !== 'all' || $('difficulty').value !== 'all');
  const results = searchConnections({ query: $('search').value, category, company: $('company').value, difficulty: $('difficulty').value, connectedIds: connected, view });
  $('connected-count').textContent = String(connected.size);
  $('browse-view').toggleAttribute('aria-current', view === 'all');
  $('connected-view').toggleAttribute('aria-current', view === 'connected');
  (view === 'all' ? $('browse-view') : $('connected-view')).setAttribute('aria-current', 'page');
  $('page-title').textContent = view === 'connected' ? 'Your connections' : 'Connection center';
  $('page-subtitle').textContent = view === 'connected' ? 'Your demo connections, all together. These stay in this browser.' : 'A little help bringing your home together. Find a company or choose a category.';
  $('results-heading').firstChild.textContent = category !== 'all' ? `${categories.get(category).label} ` : view === 'connected' ? 'Connected in demo mode ' : 'All connections ';
  $('results-count').textContent = `${results.length}`;
  $('reset-filters').hidden = !filtersActive;
  $('clear-search').hidden = !$('search').value;
  $('clear-connections').hidden = view !== 'connected' || !connected.size;
  if (!connected.size) $('clear-confirmation').hidden = true;
  renderCategories();

  const rows = results.map(item => {
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
    meta.append(el('span', '', categoryText(item)));
    if (item.availability === 'restricted') meta.append(el('span', 'availability-label', 'Limited access'));
    copy.append(title, el('p', 'connection-description', item.description), meta);
    main.append(symbol, copy);
    const difficulty = el('div', 'connection-difficulty');
    difficulty.append(difficultyBadge(item));
    const action = el('div', 'row-action');
    const isConnected = connected.has(item.id);
    const actionButton = button(isConnected ? '' : item.difficulty === 'easy' ? 'Connect' : 'View setup', isConnected ? 'connected' : item.difficulty === 'easy' ? 'secondary' : 'secondary', () => {
      returnFocusId = `action-${item.id}`;
      if (!isConnected && item.difficulty === 'easy') connect(item);
      else location.hash = `setup/${item.id}`;
    });
    actionButton.id = `action-${item.id}`;
    if (isConnected) {
      const label = el('span');
      label.append(icon('check'), document.createTextNode('Connected'));
      actionButton.append(label, el('span', 'demo-word', 'Demo · Manage'));
      actionButton.setAttribute('aria-label', `Manage ${item.name}, connected in demo mode`);
    } else actionButton.setAttribute('aria-label', `${item.difficulty === 'easy' ? 'Connect' : 'View setup for'} ${item.name}${item.difficulty === 'easy' ? ' in demo mode' : ''}`);
    action.append(actionButton);
    row.append(main, difficulty, action);
    return row;
  });
  $('connection-list').replaceChildren(...rows);
  $('empty-state').hidden = results.length !== 0;
  document.querySelector('.list-head').hidden = results.length === 0;
  if (!results.length) {
    const firstConnection = view === 'connected' && !connected.size;
    $('empty-icon').replaceChildren(icon(firstConnection ? 'plug' : 'search'));
    $('empty-title').textContent = firstConnection ? 'Your home starts here' : 'No matching connections';
    $('empty-description').textContent = firstConnection ? 'Browse a company you own and try its setup. Your demo connections will appear here.' : 'Try another company or device, or reset your filters to see more options.';
    $('empty-action').textContent = firstConnection ? 'Browse connections' : 'Reset filters';
    $('empty-action').onclick = () => firstConnection ? changeView('all') : resetFilters();
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
  $('clear-confirmation').hidden = true;
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

function list(tag, className, items) {
  const node = el(tag, className);
  node.append(...items.map(text => el('li', '', text)));
  return node;
}

function renderSetup(item, focusAction = false) {
  const container = $('setup');
  const back = button('Back to connections', 'text-button back-button', () => { location.hash = ''; });
  back.prepend(icon('back'));
  const layout = el('div', 'setup-layout');
  const summary = el('div', 'setup-summary');
  const symbol = el('span', 'setup-symbol');
  symbol.append(icon(categories.get(item.categoryIds[0])?.icon || 'hub'));
  const title = el('h1', '', item.name);
  title.id = 'setup-title';
  title.tabIndex = -1;
  const rating = el('div', 'setup-rating');
  rating.append(difficultyBadge(item), el('span', '', 'Connection difficulty'));
  const info = el('dl');
  info.append(el('dt', '', 'Company'), el('dd', '', item.company), el('dt', '', 'Categories'), el('dd', '', categoryText(item)), el('dt', '', 'Connection route'), el('dd', '', item.method));
  summary.append(symbol, title, el('p', '', item.description), rating, el('p', 'difficulty-reason', item.difficultyReason), info);

  const guide = el('div', 'setup-guide');
  guide.append(el('h2', '', 'How to connect'), el('p', 'guide-intro', 'A guide for the real setup. You can try the demo below without completing these steps.'));
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
  const link = el('a', 'guide-link', 'Open the official setup reference');
  link.href = item.guideUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.append(icon('external'));
  guide.append(link);

  const demo = el('div', 'demo-connect');
  const isConnected = connected.has(item.id);
  const demoTitle = el('h3', isConnected ? 'success-title' : '', isConnected ? 'Connected in demo mode' : 'Try this connection');
  if (isConnected) demoTitle.prepend(icon('check'));
  demo.append(demoTitle, el('p', '', isConnected ? 'Saved in this browser. No account was authorized and no hardware is connected.' : 'This saves a demo connection in your browser. No passwords, tokens, or real device access needed.'));
  const action = button(isConnected ? 'Disconnect demo' : 'Connect in demo mode', isConnected ? 'secondary danger' : '', () => isConnected ? disconnect(item) : connect(item));
  action.id = 'setup-action';
  demo.append(action);
  if (isConnected) demo.append(button('View my connections', 'secondary', () => changeView('connected')));
  guide.append(demo);
  layout.append(summary, guide);
  container.replaceChildren(back, layout);
  if (focusAction) action.focus({ preventScroll: true });
}

function route() {
  const id = location.hash.startsWith('#setup/') ? location.hash.slice(7) : null;
  const item = byId.get(id);
  if (item) {
    if (!selectedId) listScroll = window.scrollY;
    selectedId = id;
    $('directory').hidden = true;
    $('setup').hidden = false;
    renderSetup(item);
    document.title = `${item.name} setup · MERLIN`;
    window.scrollTo(0, 0);
    $('setup-title').focus({ preventScroll: true });
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
const companies = [...new Set(CONNECTIONS.map(item => item.company))].sort((a, b) => a.localeCompare(b));
companies.forEach(company => { const option = el('option', '', company); option.value = company; $('company').append(option); });
CATEGORIES.forEach(category => { const option = el('option', '', category.label); option.value = category.id; $('category-mobile').append(option); });
$('search').addEventListener('input', renderList);
$('company').addEventListener('change', renderList);
$('difficulty').addEventListener('change', renderList);
$('category-mobile').addEventListener('change', () => { category = $('category-mobile').value; renderList(); });
$('reset-filters').addEventListener('click', resetFilters);
$('clear-search').addEventListener('click', () => { $('search').value = ''; renderList(); $('search').focus(); });
$('browse-view').addEventListener('click', () => changeView('all'));
$('connected-view').addEventListener('click', () => changeView('connected'));
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); changeView('all'); });
$('clear-connections').addEventListener('click', () => { $('clear-confirmation').hidden = false; $('cancel-clear').focus(); });
$('cancel-clear').addEventListener('click', () => { $('clear-confirmation').hidden = true; $('clear-connections').focus(); });
$('confirm-clear').addEventListener('click', () => {
  connected.clear();
  persist();
  $('clear-confirmation').hidden = true;
  renderList();
  $('connected-view').focus();
  toast('All demo connections cleared.');
});
window.addEventListener('hashchange', route);
window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  const focusedId = document.activeElement?.id;
  const next = readConnections(storage, allowedIds);
  connected = next.ids;
  showStorageWarning(next.error);
  renderList();
  if (selectedId) renderSetup(byId.get(selectedId));
  if (focusedId) (document.getElementById(focusedId) || (selectedId ? $('setup-action') : $('search'))).focus({ preventScroll: true });
});
showStorageWarning(saved.error);
route();
