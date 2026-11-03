/* The big "tap to play" screen MERLIN pulls down when a spoken request asks for a Spotify playlist.
   Spotify's developer policy forbids voice control, so nothing reaches Spotify until a person taps Play.
   One layout feeds the painter and the tap target, like the connection screen. The robot stands in
   front of the middle of the ceiling card, so the button lives in the right column, clear of ROBOT_ZONE.
   Drawing is display-only; the caller performs the tap. */
import {COLORS} from './render.js';
import {ROBOT_ZONE} from './connections.js';

export const PLAY_OFFER_PANEL = 'music-offer';
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const isLandscape = (w, h) => w / h >= 1.15;
const NOTE = 'Plays on your active Spotify device.';

/** Every shape in logical canvas units. The Play button is the only tap target. */
export function playOfferLayout(state, width, height) {
  const w = width, h = height, wide = isLandscape(w, h), pad = (wide ? .045 : .07) * w;
  const status = state?.status || 'ready', busy = status === 'starting', playing = status === 'playing';
  const items = [
    {kind: 'title', x: pad, y: (wide ? .1 : .08) * h, text: state?.title || 'Your playlist', size: Math.round((wide ? .075 : .055) * h)},
    {kind: 'subtitle', x: pad, y: (wide ? .18 : .13) * h, text: playing ? 'Playing on Spotify' : 'Spotify playlist, ready when you are', size: Math.round((wide ? .034 : .026) * h)},
  ];
  // Wide: the record on the left, the button on the right, both outside the robot's footprint.
  const disc = wide ? {x: .17 * w, y: .58 * h, r: Math.min(.15 * h, (ROBOT_ZONE.x0 * w - pad) * .42)} : {x: .5 * w, y: .36 * h, r: .13 * h};
  items.push({kind: 'disc', ...disc});
  const r = wide ? Math.min(.15 * h, ((1 - ROBOT_ZONE.x1) * w - pad) * .4) : .1 * h;
  const cx = wide ? ((ROBOT_ZONE.x1 + 1) / 2) * w - pad / 2 : .5 * w, cy = wide ? .52 * h : .66 * h;
  if (!playing) items.push({kind: 'play', action: 'play', label: `Play ${state?.title || 'your playlist'} on Spotify`, x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, cx, cy, r, disabled: busy});
  const caption = playing ? 'Enjoy your workout!' : busy ? 'Starting…' : status === 'error' ? (state?.notice || 'That didn’t start. Tap to try again.') : 'Tap to play';
  items.push({kind: 'caption', x: cx, y: cy + r + .07 * h, text: caption, size: Math.round((wide ? .036 : .028) * h), max: wide ? (1 - ROBOT_ZONE.x1) * w - pad : w - 2 * pad, error: status === 'error'});
  items.push({kind: 'note', x: pad, y: (wide ? .93 : .95) * h, text: NOTE, size: Math.round((wide ? .026 : .022) * h)});
  return items;
}

export function playOfferTargets(state, width, height) {
  return playOfferLayout(state, width, height).filter(item => item.action && !item.disabled)
    .map(({action, label, x, y, w, h}) => ({id: action, action, label, x, y, w, h}));
}

export function playOfferDescription(state) {
  const title = state?.title || 'Your playlist';
  if (state?.status === 'playing') return `${title}. Playing on Spotify.`;
  if (state?.status === 'starting') return `${title}. Starting on Spotify.`;
  if (state?.status === 'error') return `${title}. ${state.notice || 'That didn’t start.'} Tap Play to try again.`;
  return `${title}. Spotify playlist ready. Tap Play to start it. ${NOTE}`;
}

function text(c, value, x, y, size, {color = COLORS.ink, weight = 500, align = 'left', max = Infinity} = {}) {
  c.fillStyle = color; c.textAlign = align; c.textBaseline = 'middle'; let fs = size;
  const content = String(value ?? '');
  do { c.font = `${weight} ${fs}px ${FONT}`; if (c.measureText(content).width <= max || fs <= 16) break; fs -= 1; } while (fs > 16);
  let shown = content;
  if (c.measureText(shown).width > max) { while (shown && c.measureText(`${shown}…`).width > max) shown = shown.slice(0, -1); shown += '…'; }
  c.fillText(shown, x, y); return shown;
}
const circle = (c, x, y, r, fill) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = fill; c.fill(); };

export function paintPlayOffer(c, width, height, state) {
  const w = width, h = height;
  c.save();
  c.fillStyle = COLORS.paper; c.fillRect(0, 0, w, h);
  c.fillStyle = COLORS.cyan; c.fillRect(0, 0, w, .012 * h);
  for (const item of playOfferLayout(state, w, h)) {
    if (item.kind === 'title') text(c, item.text, item.x, item.y, item.size, {weight: 650, max: w * .6});
    else if (item.kind === 'subtitle') text(c, item.text, item.x, item.y, item.size, {color: COLORS.muted, max: w * .6});
    else if (item.kind === 'note') text(c, item.text, item.x, item.y, item.size, {color: COLORS.muted, max: ROBOT_ZONE.x0 * w - item.x});
    else if (item.kind === 'disc') {
      circle(c, item.x, item.y, item.r, COLORS.ink);
      for (const f of [.71, .82, .92]) { c.beginPath(); c.arc(item.x, item.y, item.r * f, 0, Math.PI * 2); c.strokeStyle = '#38546a'; c.lineWidth = 2; c.stroke(); }
      circle(c, item.x, item.y, item.r * .35, COLORS.cyan); circle(c, item.x, item.y, item.r * .07, COLORS.paper);
    } else if (item.kind === 'play') {
      circle(c, item.cx, item.cy, item.r, item.disabled ? COLORS.quiet : COLORS.blue);
      const s = item.r * .42; c.beginPath(); c.moveTo(item.cx - s * .7, item.cy - s); c.lineTo(item.cx + s, item.cy); c.lineTo(item.cx - s * .7, item.cy + s); c.closePath();
      c.fillStyle = item.disabled ? COLORS.muted : COLORS.paper; c.fill();
    } else if (item.kind === 'caption') text(c, item.text, item.x, item.y, item.size, {align: 'center', weight: 600, color: item.error ? COLORS.amber : COLORS.blue, max: item.max});
  }
  c.restore();
}
