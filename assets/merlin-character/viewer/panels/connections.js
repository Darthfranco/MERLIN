/* The connection touchscreen: the large ceiling screen MERLIN pulls down to show what can be
   connected. One layout function feeds both the painter and the tap targets, so the buttons the
   page places over the 3D texture always match what is drawn.

   The robot stands in front of the middle of the ceiling card. In landscape, controls live in the
   top band and the two side columns and never inside ROBOT_ZONE (measured from the authored
   ceiling clips). Drawing is display-only; execution belongs to the caller.

   It shows real connector status and honest setup guides. It never asks for a credential: setup
   buttons open the Connection Center page, where secrets are typed in a normal browser tab. */
import {COLORS} from './render.js';

export const CONNECTIONS_PANEL = 'connections';
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
// Fractions of the card, from the CeilingIdle/CeilingThinking footprints (robot spans x .36-.64, y .50-bottom).
export const ROBOT_ZONE = Object.freeze({x0: .34, x1: .66, y0: .47});
const HARD = {ink: '#82433b', bg: '#f8efed'};
const DIFFICULTY = {easy: {label: 'Easy', ink: COLORS.green, bg: COLORS.greenBg}, medium: {label: 'Medium', ink: COLORS.amber, bg: COLORS.amberBg}, hard: {label: 'Hard', ink: HARD.ink, bg: HARD.bg}};
/* What each real status looks like. Only `connected` is green, and only a verified connector reaches it.
   tile: the line at the bottom of a tile. chip: the pill on the setup view. spoken: the screen-reader wording. */
const STATUS = {
  connected: {tile: 'Connected ✓', chip: 'Connected ✓', spoken: 'connected and verified', ink: COLORS.green, bg: COLORS.greenBg, line: COLORS.green},
  saved: {tile: 'Setup unfinished', chip: 'Setup unfinished', spoken: 'setup unfinished, not usable yet', ink: COLORS.amber, bg: COLORS.amberBg, line: COLORS.amber},
  attention: {tile: 'Needs attention', chip: 'Needs attention', spoken: 'needs attention', ink: HARD.ink, bg: HARD.bg, line: HARD.ink},
  available: {tile: 'Set up ›', chip: 'Not connected', spoken: 'not connected, can be set up', ink: COLORS.blue, bg: COLORS.ice, line: COLORS.line},
  guide: {tile: 'Via Home Assistant ›', chip: 'Via Home Assistant', spoken: 'setup guide only, works through Home Assistant', ink: COLORS.blue, bg: COLORS.ice, line: COLORS.line},
  none: {tile: 'Not supported', chip: 'Not supported', spoken: 'not supported', ink: COLORS.muted, bg: COLORS.quiet, line: COLORS.line},
  unavailable: {tile: 'Unavailable', chip: 'Unavailable', spoken: 'unavailable', ink: COLORS.muted, bg: COLORS.quiet, line: COLORS.line},
};
const statusStyle = status => STATUS[status] || STATUS.none;
const NOTICE = 'Connect real services on the Connection Center page. Guides don’t connect MERLIN.';
const isLandscape = (w, h) => w / h >= 1.15;

export const pageSize = (width, height) => isLandscape(width, height) ? 6 : 5;
export function pageCount(state, width, height) { return Math.max(1, Math.ceil((state?.tiles?.length || 0) / pageSize(width, height))); }

const chipWidth = label => Math.round(44 + String(label).length * 17);

/** The large close button on a big screen in the home display's top-right corner, clear of the robot and the chips. */
export function closeTarget(width, height) {
  const pad = (isLandscape(width, height) ? .045 : .06) * width, d = .1 * height;
  return {x: width - pad - d, y: .03 * height, w: d, h: d, hit: {x: width - pad - d - .04 * width, y: 0, w: pad + d + .04 * width, h: .15 * height}};
}
export function paintClose(c, {x, y, w}) {
  const r = w / 2, cx = x + r, cy = y + r, k = r * .36;
  c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fillStyle = COLORS.quiet; c.fill();
  c.strokeStyle = COLORS.muted; c.lineWidth = Math.max(3, r * .12); c.lineCap = 'round';
  c.beginPath(); c.moveTo(cx - k, cy - k); c.lineTo(cx + k, cy + k); c.moveTo(cx + k, cy - k); c.lineTo(cx - k, cy + k); c.stroke();
}

/** Every rectangle in logical canvas units. `action` marks tap targets. */
export function connectionsLayout(state, width, height) {
  const items = baseLayout(state, width, height);
  if (state?.closable) items.push({kind: 'close', action: 'close', label: 'Close the connection screen', ...closeTarget(width, height)});
  return items;
}
function baseLayout(state, width, height) {
  const w = width, h = height, wide = isLandscape(w, h), items = [];
  const add = item => { items.push(item); return item; };
  const pad = wide ? .045 * w : .06 * w;
  const setup = state?.view === 'setup' && state.setup;
  add({kind: 'title', x: pad, y: (wide ? .075 : .06) * h, text: setup ? state.setup.name : 'Connect your home', size: Math.round((wide ? .052 : .04) * h)});
  add({kind: 'subtitle', x: pad, y: (wide ? .125 : .1) * h, size: Math.round((wide ? .027 : .02) * h),
    text: state?.notice || NOTICE});

  if (setup) {
    const s = state.setup, bar = (wide ? .085 : .06) * h, gap = .015 * w;
    let rowTop = (wide ? .16 : .15) * h, x = pad;
    // Narrow cards wrap the action row instead of running off the edge.
    const button = ({action, value, label, text: caption, primary = false, disabled = false, danger = false}) => {
      const bw = Math.round(56 + caption.length * 17);
      if (x > pad && x + bw > w - pad) { x = pad; rowTop += bar + .012 * h; }
      const placed = add({kind: 'button', action, value, label, text: caption, x, y: rowTop, w: bw, h: bar, primary, disabled, danger});
      x += bw + gap; return placed;
    };
    for (const spec of setupActions(s)) button(spec);
    const rowEnd = rowTop + bar;
    const difficulty = DIFFICULTY[s.difficulty] || DIFFICULTY.medium, style = statusStyle(s.status);
    // The pill states the real status. "Easy" and the like describe household effort, not whether anything is connected.
    const chipText = `${difficulty.label} · ${style.chip}`;
    const col = .275 * w, leftX = pad, rightX = w - pad - col;
    if (wide) {
      // The free band above the robot's head holds the status pill and a short live summary.
      const bx = (ROBOT_ZONE.x0 + .015) * w, by = Math.max(.31 * h, rowEnd + .045 * h), pw = (ROBOT_ZONE.x1 - ROBOT_ZONE.x0 - .03) * w, ps = Math.round(.026 * h);
      const size = Math.min(Math.round(.03 * h), Math.floor((pw - 40) / (chipText.length * .6)));
      add({kind: 'badge', x: bx, y: by, w: Math.min(pw, Math.round(chipText.length * size * .6 + 40)), h: size * 1.5, text: chipText, ink: style.ink, bg: style.bg, size});
      add({kind: 'paragraph', x: bx, y: by + .065 * h, w: pw, h: ps * 1.4 * 2, lines: s.summary ? [s.summary] : [], size: ps, max: 2});
      const top = Math.max(.30 * h, rowEnd + .02 * h), bottom = .93 * h;
      add({kind: 'list', heading: 'You’ll need', x: leftX, y: top, w: col, h: .31 * h, items: (s.requirements || []).slice(0, 2), numbered: false});
      add({kind: 'note', heading: 'What MERLIN can do', x: leftX, y: top + .335 * h, w: col, h: bottom - (top + .335 * h), text: s.afterwards, size: 24});
      add({kind: 'list', heading: 'Steps', x: rightX, y: top, w: col, h: .33 * h, items: (s.steps || []).slice(0, 3), numbered: true});
      add({kind: 'note', heading: 'What’s missing', x: rightX, y: top + .345 * h, w: col, h: bottom - (top + .345 * h), text: s.remaining, size: 24});
    } else {
      const size = Math.min(Math.round(.03 * h), Math.floor((w - 2 * pad - 40) / (chipText.length * .6)));
      const by = rowEnd + .035 * h, ps = Math.round(.026 * h), pw = w - 2 * pad;
      add({kind: 'badge', x: pad, y: by, w: Math.min(pw, Math.round(chipText.length * size * .6 + 40)), h: size * 1.5, text: chipText, ink: style.ink, bg: style.bg, size});
      add({kind: 'paragraph', x: pad, y: by + .065 * h, w: pw, h: ps * 1.4 * 2, lines: s.summary ? [s.summary] : [], size: ps, max: 2});
      // Narrow card: what MERLIN can and cannot do outranks the requirement list (the Connection Center page has it in full).
      // The three blocks share whatever height is left below the action rows, so a wrapped row never pushes them off the card.
      const y1 = by + .135 * h, avail = Math.max(.2 * h, .985 * h - y1);
      add({kind: 'note', heading: 'What MERLIN can do', x: pad, y: y1, w: pw, h: avail * .36, text: s.afterwards, size: 24});
      add({kind: 'note', heading: 'What’s missing', x: pad, y: y1 + avail * .36, w: pw, h: avail * .27, text: s.remaining, size: 24});
      add({kind: 'list', heading: 'Steps', x: pad, y: y1 + avail * .63, w: pw, h: avail * .37, items: (s.steps || []).slice(0, 3), numbered: true});
    }
    return items;
  }

  // Browse: category chips, then paged tiles.
  const chipTop = (wide ? .16 : .13) * h, chipH = (wide ? .075 : .055) * h, chipGap = .012 * w;
  let cx = pad, cy = chipTop, rows = 1;
  // On the wide card the chips stay on one row, so they shrink together rather than wrap into the tiles.
  const chips = state?.categories || [], room = w - 2 * pad - chipGap * Math.max(0, chips.length - 1);
  const natural = chips.reduce((sum, category) => sum + chipWidth(category.label), 0), fit = wide && natural > room ? room / natural : 1;
  for (const category of chips) {
    const cw = Math.round(chipWidth(category.label) * fit);
    if (cx + cw > w - pad) { cx = pad; cy += chipH + .012 * h; rows++; }
    add({kind: 'chip', action: 'category', value: category.id, label: `Show ${category.label} options${category.active ? ', selected' : ''}`, text: category.label, active: Boolean(category.active), x: cx, y: cy, w: cw, h: chipH});
    cx += cw + chipGap;
  }
  const size = pageSize(w, h), pages = pageCount(state, w, h), page = Math.min(Math.max(0, state?.page || 0), pages - 1);
  const visible = (state?.tiles || []).slice(page * size, page * size + size);
  const shown = visible.length;
  if (wide) {
    const col = .275 * w, tileH = .19 * h, tileGap = .022 * h, top = .30 * h;
    visible.forEach((tile, index) => {
      const column = index < 3 ? 0 : 1, row = index % 3;
      add({kind: 'tile', tile, x: column ? w - pad - col : pad, y: top + row * (tileH + tileGap), w: col, h: tileH});
    });
    if (pages > 1) {
      const by = .31 * h, bh = .095 * h, bw = .1 * w;
      add({kind: 'button', action: 'page', value: -1, label: 'Previous page of connections', text: '‹', x: .36 * w, y: by, w: bw, h: bh, disabled: page === 0});
      add({kind: 'pager', text: `${page + 1} / ${pages}`, x: .5 * w, y: by + bh / 2, size: Math.round(.035 * h)});
      add({kind: 'button', action: 'page', value: 1, label: 'Next page of connections', text: '›', x: .64 * w - bw, y: by, w: bw, h: bh, disabled: page >= pages - 1});
    }
    if (!shown) add({kind: 'empty', x: .5 * w, y: .36 * h, text: 'Nothing here yet. Try another category.', size: Math.round(.035 * h)});
  } else {
    const tileH = .105 * h, tileGap = .014 * h, top = chipTop + rows * (chipH + .012 * h) + .02 * h;
    visible.forEach((tile, index) => add({kind: 'tile', tile, x: pad, y: top + index * (tileH + tileGap), w: w - 2 * pad, h: tileH}));
    if (pages > 1) {
      const by = .9 * h, bh = .065 * h, bw = .18 * w;
      add({kind: 'button', action: 'page', value: -1, label: 'Previous page of connections', text: '‹', x: pad, y: by, w: bw, h: bh, disabled: page === 0});
      add({kind: 'pager', text: `${page + 1} / ${pages}`, x: .5 * w, y: by + bh / 2, size: Math.round(.03 * h)});
      add({kind: 'button', action: 'page', value: 1, label: 'Next page of connections', text: '›', x: w - pad - bw, y: by, w: bw, h: bh, disabled: page >= pages - 1});
    }
    if (!shown) add({kind: 'empty', x: .5 * w, y: .5 * h, text: 'Nothing here yet. Try another category.', size: Math.round(.03 * h)});
  }
  return items;
}

/** The buttons on the setup view for a real status. Credentials are never entered here: setup opens the Connection Center page. */
function setupActions(s) {
  const actions = [{action: 'back', label: 'Back to the connection list', text: '‹ Back'}];
  const connected = s.status === 'connected', busy = Boolean(s.busy);
  if (s.type === 'native' && s.real) {
    actions.push({action: 'setup', label: 'Open the Spotify setup page in a new tab', text: 'Open Spotify setup', primary: !connected});
    if (connected) actions.push(disconnectSpec(s, busy));
  } else if (s.type === 'native') {
    if (connected) {
      actions.push({action: 'verify', label: `Check that ${s.name} still works`, text: s.busy === 'verify' ? 'Checking…' : 'Check connection', primary: true, disabled: busy});
      actions.push(disconnectSpec(s, busy));
    } else if (s.status === 'attention') {
      actions.push({action: 'setup', label: `Reconnect ${s.name}. Opens the Connection Center page in a new tab`, text: 'Reconnect', primary: true});
      actions.push({action: 'verify', label: `Check ${s.name} again`, text: s.busy === 'verify' ? 'Checking…' : 'Check again', disabled: busy});
    } else if (s.status === 'saved') {
      actions.push({action: 'setup', label: `Finish ${s.name} setup. Opens the Connection Center page in a new tab`, text: 'Finish setup', primary: true});
    } else if (s.status !== 'unavailable') {
      actions.push({action: 'setup', label: `Set up ${s.name} on this computer. Opens the Connection Center page in a new tab`, text: 'Set up on this computer', primary: true});
    }
  } else if (s.via === 'home-assistant') {
    actions.push({action: 'open', value: 'home-assistant', label: `Open Home Assistant setup. ${s.name} works only through Home Assistant`, text: 'Set up Home Assistant', primary: true});
  }
  if (s.guideUrl) actions.push({action: 'guide', label: `Open the official ${s.name} guide in a new tab`, text: 'Official guide ↗'});
  return actions;
}
function disconnectSpec(s, busy) {
  return s.confirmDisconnect
    ? {action: 'disconnect', label: `Tap again to disconnect ${s.name}`, text: 'Tap again to disconnect', danger: true, disabled: busy}
    : {action: 'disconnect', label: `Disconnect ${s.name}`, text: 'Disconnect', disabled: busy};
}

/** Tap targets in logical units: {id, action, value, label, x, y, w, h}. */
export function connectionTargets(state, width, height) {
  const targets = [];
  for (const item of connectionsLayout(state, width, height)) {
    if (item.action && !item.disabled) targets.push({id: `${item.action}:${item.value ?? ''}`, action: item.action, value: item.value, label: item.label, ...(item.hit ?? {x: item.x, y: item.y, w: item.w, h: item.h})});
    if (item.kind !== 'tile') continue;
    const tile = item.tile;
    targets.push({id: `open:${tile.id}`, action: 'open', value: tile.id, label: `${tile.name}, ${DIFFICULTY[tile.difficulty]?.label.toLowerCase() || 'medium'} setup, ${statusStyle(tile.status).spoken}. Open details`, x: item.x, y: item.y, w: item.w, h: item.h});
  }
  return targets;
}

export function connectionsDescription(state) {
  if (state?.view === 'setup' && state.setup) {
    const s = state.setup;
    return `${s.name} setup. ${DIFFICULTY[s.difficulty]?.label || 'Medium'} setup. ${statusStyle(s.status).spoken.replace(/^./u, letter => letter.toUpperCase())}. ${s.summary || ''}`.trim();
  }
  const active = (state?.categories || []).find(category => category.active);
  return `Connection options${active ? `: ${active.label}` : ''}. ${state?.tiles?.length || 0} listed. ${NOTICE}`;
}

function rr(c, x, y, w, h, r, fill, stroke) { c.beginPath(); c.roundRect(x, y, w, h, r); if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.strokeStyle = stroke; c.lineWidth = 2; c.stroke(); } }
function text(c, value, x, y, size, {color = COLORS.ink, weight = 500, align = 'left', max = Infinity} = {}) {
  c.fillStyle = color; c.textAlign = align; c.textBaseline = 'middle'; let fs = size;
  const content = String(value ?? '');
  do { c.font = `${weight} ${fs}px ${FONT}`; if (c.measureText(content).width <= max || fs <= 16) break; fs -= 1; } while (fs > 16);
  let shown = content;
  if (c.measureText(shown).width > max) { while (shown && c.measureText(`${shown}…`).width > max) shown = shown.slice(0, -1); shown += '…'; }
  c.fillText(shown, x, y); return shown;
}
function wrap(c, value, max, size, weight, lines) {
  c.font = `${weight} ${size}px ${FONT}`;
  const words = String(value ?? '').split(/\s+/u).filter(Boolean), out = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && c.measureText(next).width > max) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  if (out.length > lines) { out.length = lines; out[lines - 1] = `${out[lines - 1].replace(/[\s.,;:]+$/u, '')}…`; }
  return out;
}

export function paintConnections(c, width, height, state) {
  const w = width, h = height;
  c.save();
  c.fillStyle = COLORS.paper; c.fillRect(0, 0, w, h);
  const header = rr; header(c, 0, 0, w, .012 * h, 0, COLORS.cyan);
  for (const item of connectionsLayout(state, w, h)) {
    if (item.kind === 'title') text(c, item.text, item.x, item.y, item.size, {weight: 650, max: w * .62});
    else if (item.kind === 'subtitle') text(c, item.text, item.x, item.y, item.size, {color: COLORS.muted, max: w - 2 * item.x});
    else if (item.kind === 'chip') {
      rr(c, item.x, item.y, item.w, item.h, item.h / 2, item.active ? COLORS.blue : COLORS.ice, item.active ? null : COLORS.line);
      text(c, item.text, item.x + item.w / 2, item.y + item.h / 2, Math.round(item.h * .46), {align: 'center', weight: 600, color: item.active ? '#ffffff' : COLORS.ink, max: item.w - 20});
    } else if (item.kind === 'button') {
      const fill = item.disabled ? COLORS.quiet : item.danger ? HARD.bg : item.primary ? COLORS.blue : COLORS.ice;
      rr(c, item.x, item.y, item.w, item.h, 20, fill, item.primary || item.disabled ? null : item.danger ? HARD.ink : COLORS.line);
      text(c, item.text, item.x + item.w / 2, item.y + item.h / 2, Math.round(item.h * .42), {align: 'center', weight: 650, color: item.disabled ? COLORS.muted : item.danger ? HARD.ink : item.primary ? '#ffffff' : COLORS.blue, max: item.w - 16});
    } else if (item.kind === 'pager') text(c, item.text, item.x, item.y, item.size, {align: 'center', color: COLORS.muted, weight: 600});
    else if (item.kind === 'empty') text(c, item.text, item.x, item.y, item.size, {align: 'center', color: COLORS.muted});
    else if (item.kind === 'badge') {
      c.font = `650 ${item.size}px ${FONT}`; const bw = c.measureText(item.text).width + 36;
      rr(c, item.x, item.y - item.size * .75, bw, item.size * 1.5, item.size * .75, item.bg);
      text(c, item.text, item.x + 18, item.y, item.size, {weight: 650, color: item.ink});
    } else if (item.kind === 'paragraph') {
      item.lines.forEach((line, i) => wrap(c, line, item.w, item.size, 500, item.max).forEach((part, j) => text(c, part, item.x, item.y + (i + j) * item.size * 1.4, item.size, {color: COLORS.muted, max: item.w})));
    } else if (item.kind === 'list') paintList(c, item);
    else if (item.kind === 'close') paintClose(c, item);
    else if (item.kind === 'note') paintNote(c, item);
    else if (item.kind === 'tile') paintTile(c, item);
  }
  c.restore();
}

function paintList(c, item) {
  text(c, item.heading, item.x, item.y, 34, {weight: 650, color: COLORS.blue, max: item.w});
  let y = item.y + 58; const size = 26, line = size * 1.38;
  item.items.forEach((entry, index) => {
    const parts = wrap(c, entry, item.w - 46, size, 500, 3);
    if (y + parts.length * line > item.y + item.h) return;
    if (item.numbered) { rr(c, item.x, y - size * .6, 34, 34, 17, COLORS.ice); text(c, index + 1, item.x + 17, y + 1, 22, {align: 'center', weight: 650, color: COLORS.blue}); }
    else rr(c, item.x + 10, y - 6, 12, 12, 6, COLORS.cyan);
    parts.forEach((part, i) => text(c, part, item.x + 46, y + i * line, size, {color: COLORS.ink, max: item.w - 46}));
    y += parts.length * line + 16;
  });
}

function paintNote(c, item) {
  text(c, item.heading, item.x, item.y, 34, {weight: 650, color: COLORS.blue, max: item.w});
  if (!item.text) return;
  const line = item.size * 1.38, lines = Math.max(1, Math.floor((item.h - 58 - item.size / 2) / line) + 1);
  wrap(c, item.text, item.w, item.size, 500, lines).forEach((part, i) => text(c, part, item.x, item.y + 58 + i * line, item.size, {color: COLORS.ink, max: item.w}));
}

function paintTile(c, item) {
  const {x, y, w, h, tile} = item, style = statusStyle(tile.status), live = ['connected', 'saved', 'attention'].includes(tile.status), dim = ['none', 'unavailable'].includes(tile.status);
  rr(c, x, y, w, h, 24, live ? style.bg : dim ? COLORS.quiet : '#ffffff', live ? style.line : COLORS.line);
  const logo = Math.min(h * .42, 86);
  rr(c, x + h * .12, y + h * .12, logo, logo, logo * .28, COLORS.ice);
  text(c, String(tile.name).trim().charAt(0).toUpperCase(), x + h * .12 + logo / 2, y + h * .12 + logo / 2 + 2, logo * .55, {align: 'center', weight: 700, color: COLORS.blue});
  const tx = x + h * .12 + logo + h * .1, tw = x + w - tx - h * .08;
  text(c, tile.name, tx, y + h * .27, Math.round(h * .21), {weight: 650, max: tw, color: dim ? COLORS.muted : COLORS.ink});
  text(c, tile.sub || '', tx, y + h * .5, Math.round(h * .14), {color: COLORS.muted, max: tw});
  const difficulty = DIFFICULTY[tile.difficulty] || DIFFICULTY.medium;
  if (w / h < 3.2) {
    // Compact tile (the ceiling card's columns): the difficulty chip sits under the logo so the status line has the full width.
    const bs = Math.round(h * .105); c.font = `650 ${bs}px ${FONT}`; const bw = Math.min(logo + h * .2, c.measureText(difficulty.label).width + 20);
    const bx = Math.max(x + 8, x + h * .12 + logo / 2 - bw / 2), by = y + h * .12 + logo + h * .06;
    rr(c, bx, by, bw, bs * 1.5, bs * .75, difficulty.bg);
    text(c, difficulty.label, bx + bw / 2, by + bs * .75, bs, {align: 'center', weight: 650, color: difficulty.ink, max: bw - 8});
    text(c, style.tile, tx, y + h * .8, Math.round(h * .125), {weight: 650, color: style.ink, max: tw});
    return;
  }
  const bs = Math.round(h * .13); c.font = `650 ${bs}px ${FONT}`; const bw = c.measureText(difficulty.label).width + 24;
  rr(c, tx, y + h * .64, bw, bs * 1.5, bs * .75, difficulty.bg);
  text(c, difficulty.label, tx + 12, y + h * .64 + bs * .75, bs, {weight: 650, color: difficulty.ink});
  text(c, style.tile, x + w - h * .08, y + h * .83, Math.round(h * .13), {align: 'right', weight: 650, color: style.ink, max: w * .6});
}
