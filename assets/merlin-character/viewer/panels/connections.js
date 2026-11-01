/* The connection touchscreen: the large ceiling screen MERLIN pulls down to show what can be
   connected. One layout function feeds both the painter and the tap targets, so the buttons the
   page places over the 3D texture always match what is drawn.

   The robot stands in front of the middle of the ceiling card. In landscape, controls live in the
   top band and the two side columns and never inside ROBOT_ZONE (measured from the authored
   ceiling clips). Drawing is display-only; execution belongs to the caller. */
import {COLORS} from './render.js';

export const CONNECTIONS_PANEL = 'connections';
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
// Fractions of the card, from the CeilingIdle/CeilingThinking footprints (robot spans x .36-.64, y .50-bottom).
export const ROBOT_ZONE = Object.freeze({x0: .34, x1: .66, y0: .47});
const HARD = {ink: '#82433b', bg: '#f8efed'};
const DIFFICULTY = {easy: {label: 'Easy', ink: COLORS.green, bg: COLORS.greenBg}, medium: {label: 'Medium', ink: COLORS.amber, bg: COLORS.amberBg}, hard: {label: 'Hard', ink: HARD.ink, bg: HARD.bg}};
const isLandscape = (w, h) => w / h >= 1.15;

export const pageSize = (width, height) => isLandscape(width, height) ? 6 : 5;
export function pageCount(state, width, height) { return Math.max(1, Math.ceil((state?.tiles?.length || 0) / pageSize(width, height))); }

const chipWidth = label => Math.round(44 + String(label).length * 17);

/** Every rectangle in logical canvas units. `action` marks tap targets. */
export function connectionsLayout(state, width, height) {
  const w = width, h = height, wide = isLandscape(w, h), items = [];
  const add = item => { items.push(item); return item; };
  const pad = wide ? .045 * w : .06 * w;
  const setup = state?.view === 'setup' && state.setup;
  add({kind: 'title', x: pad, y: (wide ? .075 : .06) * h, text: setup ? state.setup.name : 'Connect your home', size: Math.round((wide ? .052 : .04) * h)});
  add({kind: 'subtitle', x: pad, y: (wide ? .125 : .1) * h, size: Math.round((wide ? .027 : .02) * h),
    text: state?.notice || 'Preview only: connecting records your choice. MERLIN can’t control devices yet.'});

  if (setup) {
    const s = state.setup, bar = (wide ? .085 : .06) * h, gap = .015 * w;
    let rowTop = (wide ? .16 : .15) * h, x = pad;
    // Narrow cards wrap the action row instead of running off the edge.
    const button = (action, label, text, primary, disabled = false) => {
      const bw = Math.round(80 + text.length * 21);
      if (x > pad && x + bw > w - pad) { x = pad; rowTop += bar + .012 * h; }
      const placed = add({kind: 'button', action, label, text, x, y: rowTop, w: bw, h: bar, primary, disabled});
      x += bw + gap; return placed;
    };
    button('back', 'Back to the connection list', '‹ Back', false);
    if (s.connected) button('disconnect', `Disconnect ${s.name} preview`, 'Disconnect', false, !s.disconnectable);
    else button('connect', `Connect ${s.name} as a preview`, s.real ? 'Open Spotify setup' : s.available ? 'Connect (preview)' : 'Not available', s.available, !s.available);
    if (s.guideUrl) button('guide', `Open the official ${s.name} guide in a new tab`, 'Official guide ↗', false);
    const top = rowTop;
    const badge = DIFFICULTY[s.difficulty] || DIFFICULTY.medium, size = Math.round(.03 * h);
    // "Preview" stays in the subtitle and the accessible name; the pill must fit above the robot.
    const badgeText = s.connected ? `${badge.label} · Connected` : `${badge.label} setup`;
    // Wide: the free band above the robot's head. Narrow: under the action row.
    const bx = wide ? (ROBOT_ZONE.x0 + .015) * w : pad, by = wide ? .31 * h : top + bar + .035 * h;
    add({kind: 'badge', x: bx, y: by, w: Math.round(badgeText.length * size * .6 + 40), h: size * 1.5, text: badgeText, ink: badge.ink, bg: badge.bg, size});
    const pw = wide ? (ROBOT_ZONE.x1 - ROBOT_ZONE.x0 - .03) * w : w - 2 * pad, ps = Math.round(.026 * h);
    add({kind: 'paragraph', x: bx, y: by + .065 * h, w: pw, h: ps * 1.4 * 2, lines: s.reason ? [s.reason] : [], size: ps, max: 2});
    // Requirements on the left, steps on the right: both outside the robot.
    const col = .275 * w, colTop = .30 * h, leftX = pad, rightX = w - pad - col;
    if (wide) {
      add({kind: 'list', heading: 'You’ll need', x: leftX, y: colTop, w: col, h: .62 * h, items: [...(s.requirements || []).slice(0, 3), ...(s.limitations || []).slice(0, 1).map(l => `Limit: ${l}`)], numbered: false});
      add({kind: 'list', heading: 'Steps', x: rightX, y: colTop, w: col, h: .62 * h, items: (s.steps || []).slice(0, 4), numbered: true});
    } else {
      add({kind: 'list', heading: 'You’ll need', x: pad, y: .44 * h, w: w - 2 * pad, h: .22 * h, items: (s.requirements || []).slice(0, 2), numbered: false});
      add({kind: 'list', heading: 'Steps', x: pad, y: .69 * h, w: w - 2 * pad, h: .26 * h, items: (s.steps || []).slice(0, 3), numbered: true});
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

/** Tap targets in logical units: {id, action, value, label, x, y, w, h, disabled}. */
export function connectionTargets(state, width, height) {
  const targets = [];
  for (const item of connectionsLayout(state, width, height)) {
    if (item.action && !item.disabled) targets.push({id: `${item.action}:${item.value ?? ''}`, action: item.action, value: item.value, label: item.label, x: item.x, y: item.y, w: item.w, h: item.h});
    if (item.kind !== 'tile') continue;
    const tile = item.tile, status = tile.status === 'connected' ? (tile.real ? 'connected' : 'connected as a preview') : tile.status === 'unavailable' ? 'unavailable' : 'not connected';
    targets.push({id: `open:${tile.id}`, action: 'open', value: tile.id, label: `${tile.name}, ${DIFFICULTY[tile.difficulty]?.label.toLowerCase() || 'medium'} setup, ${status}. Open details`, x: item.x, y: item.y, w: item.w, h: item.h});
    const pill = tilePill(item);
    // `within` lets the page grow a small pill into a comfortable touch size without leaving its tile.
    if (pill) targets.push({id: `connect:${tile.id}`, action: 'connect', value: tile.id, label: `Connect ${tile.name} as a preview`, x: pill.x, y: pill.y, w: pill.w, h: pill.h, within: {x: item.x, y: item.y, w: item.w, h: item.h}});
  }
  return targets;
}

// The quick Connect pill sits on easy, available, unconnected tiles (never on Spotify, which has its own setup).
function tilePill({x, y, w, h, tile}) {
  if (tile.status !== 'available' || tile.difficulty !== 'easy' || tile.real) return null;
  const pw = Math.min(w * .42, 210), ph = Math.min(h * .36, 64);
  return {x: x + w - pw - h * .1, y: y + h - ph - h * .1, w: pw, h: ph};
}

export function connectionsDescription(state) {
  if (state?.view === 'setup' && state.setup) {
    const s = state.setup;
    return `${s.name} setup guide. ${DIFFICULTY[s.difficulty]?.label || 'Medium'} setup. ${s.connected ? 'Connected' : 'Not connected'}${s.real ? '' : ' as a preview'}.`;
  }
  const active = (state?.categories || []).find(category => category.active);
  return `Connection options${active ? `: ${active.label}` : ''}. ${state?.tiles?.length || 0} available. Previews record a choice only.`;
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
      const fill = item.disabled ? COLORS.quiet : item.primary ? COLORS.blue : COLORS.ice;
      rr(c, item.x, item.y, item.w, item.h, 20, fill, item.primary || item.disabled ? null : COLORS.line);
      text(c, item.text, item.x + item.w / 2, item.y + item.h / 2, Math.round(item.h * .42), {align: 'center', weight: 650, color: item.disabled ? COLORS.muted : item.primary ? '#ffffff' : COLORS.blue, max: item.w - 16});
    } else if (item.kind === 'pager') text(c, item.text, item.x, item.y, item.size, {align: 'center', color: COLORS.muted, weight: 600});
    else if (item.kind === 'empty') text(c, item.text, item.x, item.y, item.size, {align: 'center', color: COLORS.muted});
    else if (item.kind === 'badge') {
      c.font = `650 ${item.size}px ${FONT}`; const bw = c.measureText(item.text).width + 36;
      rr(c, item.x, item.y - item.size * .75, bw, item.size * 1.5, item.size * .75, item.bg);
      text(c, item.text, item.x + 18, item.y, item.size, {weight: 650, color: item.ink});
    } else if (item.kind === 'paragraph') {
      item.lines.forEach((line, i) => wrap(c, line, item.w, item.size, 500, item.max).forEach((part, j) => text(c, part, item.x, item.y + (i + j) * item.size * 1.4, item.size, {color: COLORS.muted, max: item.w})));
    } else if (item.kind === 'list') paintList(c, item);
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

function paintTile(c, item) {
  const {x, y, w, h, tile} = item, connected = tile.status === 'connected', unavailable = tile.status === 'unavailable';
  rr(c, x, y, w, h, 24, connected ? COLORS.greenBg : unavailable ? COLORS.quiet : '#ffffff', connected ? COLORS.green : COLORS.line);
  const logo = Math.min(h * .42, 86);
  rr(c, x + h * .12, y + h * .12, logo, logo, logo * .28, COLORS.ice);
  text(c, String(tile.name).trim().charAt(0).toUpperCase(), x + h * .12 + logo / 2, y + h * .12 + logo / 2 + 2, logo * .55, {align: 'center', weight: 700, color: COLORS.blue});
  const tx = x + h * .12 + logo + h * .1, tw = x + w - tx - h * .08;
  text(c, tile.name, tx, y + h * .27, Math.round(h * .21), {weight: 650, max: tw, color: unavailable ? COLORS.muted : COLORS.ink});
  text(c, tile.sub || '', tx, y + h * .5, Math.round(h * .14), {color: COLORS.muted, max: tw});
  const difficulty = DIFFICULTY[tile.difficulty] || DIFFICULTY.medium;
  const bs = Math.round(h * .13); c.font = `650 ${bs}px ${FONT}`; const bw = c.measureText(difficulty.label).width + 24;
  rr(c, tx, y + h * .64, bw, bs * 1.5, bs * .75, difficulty.bg);
  text(c, difficulty.label, tx + 12, y + h * .64 + bs * .75, bs, {weight: 650, color: difficulty.ink});
  const pill = tilePill(item);
  if (pill) { rr(c, pill.x, pill.y, pill.w, pill.h, pill.h / 2, COLORS.blue); text(c, 'Connect', pill.x + pill.w / 2, pill.y + pill.h / 2, Math.round(pill.h * .45), {align: 'center', weight: 650, color: '#ffffff', max: pill.w - 16}); }
  else {
    const label = connected ? (tile.real ? 'Connected ✓' : 'Connected · preview ✓') : unavailable ? 'Route unavailable' : 'View setup ›';
    text(c, label, x + w - h * .08, y + h * .83, Math.round(h * .13), {align: 'right', weight: 650, color: connected ? COLORS.green : unavailable ? COLORS.muted : COLORS.blue, max: w * .6});
  }
}
