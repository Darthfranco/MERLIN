const MAX_TIMER_SECONDS = 604800;
const TIMER_STATUSES = new Set(['running', 'paused', 'finished', 'unknown']);
const MUSIC_STATUSES = new Set(['playing', 'paused', 'stopped', 'loading', 'error', 'unknown']);

function text(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  try { return String(value); } catch { return fallback; }
}

function seconds(value, maximum = Number.MAX_SAFE_INTEGER) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
}

const field = (data, key, alias) => Object.hasOwn(data, key) ? data[key] : data[alias];

/** Presentation data only. Missing state stays unknown; this never starts a tool. */
export function normalizeOverlay(type, data = {}) {
  if (!['timer', 'music'].includes(type)) throw new TypeError('Choose a timer or music overlay.');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Overlay data must be an object.');
  if (type === 'timer') {
    const status = ['done', 'completed'].includes(data.status) ? 'finished' : data.status;
    return {type, title: text(field(data, 'title', 'label'), 'Timer'),
      status: TIMER_STATUSES.has(status) ? status : 'unknown',
      remainingSeconds: seconds(field(data, 'remainingSeconds', 'seconds'), MAX_TIMER_SECONDS),
      durationSeconds: seconds(data.durationSeconds, MAX_TIMER_SECONDS)};
  }
  // Existing panel data uses elapsed/duration; explicit overlay fields win.
  const status = data.status === 'empty' ? 'stopped' : data.status === 'pending' ? 'loading' : data.status;
  return {type, title: text(data.title, 'Music'), artist: text(data.artist),
    status: MUSIC_STATUSES.has(status) ? status : 'unknown',
    positionSeconds: seconds(field(data, 'positionSeconds', 'elapsed')),
    durationSeconds: seconds(field(data, 'durationSeconds', 'duration'))};
}

/** Countdown precision, with no fabricated 00:00 for missing or invalid data. */
export function formatOverlayDuration(value) {
  if (seconds(value) === null) return '—';
  const total = Math.ceil(value), hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60), remainder = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` :
    `${minutes}:${String(remainder).padStart(2, '0')}`;
}
