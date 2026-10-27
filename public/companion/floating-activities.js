import {isFacePresentation, panelSides} from './orchestrator.js';

const MAX_TIMER_SECONDS = 604800;
const ACTIVITY_TYPES = new Set(['timer', 'music']);
const number = (value, maximum = Number.MAX_SAFE_INTEGER) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
const text = (value, fallback = '') => typeof value === 'string' && value.trim() ? value : fallback;

/** Stable presentation identity, independent of physical side and animation pose. */
export function activityIdentity(panel) {
  if (panel?.type === 'music') return 'music:spotify';
  return panel?.type === 'timer' && text(panel.id) ? `timer:${panel.id}` : null;
}

/** Local display projection only: no execution, persistence, metadata logging, or inferred completion. */
export function projectActivities({timers = [], spotify, now = Date.now()} = {}) {
  const records = new Map();
  for (const timer of Array.isArray(timers) ? timers : []) {
    if (timer && text(timer.id)) records.set(timer.id, timer);
  }
  const activities = [...records.values()]
    .filter(timer => !timer.dismissed && ['running', 'completed'].includes(timer.status))
    .sort((a, b) => Number(b.status === 'completed') - Number(a.status === 'completed'))
    .map(timer => {
      const end = Date.parse(timer.ends_at);
      const remaining = Number.isFinite(now) && Number.isFinite(end)
        ? number(Math.max(0, Math.ceil((end - now) / 1000)), MAX_TIMER_SECONDS) : null;
      return {
        id: `timer:${timer.id}`, type: 'timer', entityId: timer.id,
        action: timer.status === 'completed' ? 'dismiss' : 'cancel',
        data: {
          title: text(timer.label, 'Timer'),
          status: timer.status === 'completed' ? 'finished' : 'running',
          remainingSeconds: timer.status === 'completed' ? 0 : remaining,
          durationSeconds: number(timer.duration_seconds, MAX_TIMER_SECONDS),
        },
      };
    });

  const playback = spotify?.connected === true ? spotify.playback : null;
  if (playback?.track && text(playback.track.name)) {
    const status = playback.is_playing === true ? 'playing' : playback.is_playing === false ? 'paused' : 'unknown';
    activities.push({
      id: 'music:spotify', type: 'music', entityId: 'spotify',
      action: status === 'playing' ? 'pause' : status === 'paused' ? 'resume' : null,
      data: {
        title: playback.track.name,
        artist: (Array.isArray(playback.track.artists) ? playback.track.artists : []).filter(artist => typeof artist === 'string').join(', '),
        status,
        // These fields are currently absent from the service snapshot. Missing progress stays unknown.
        positionSeconds: number(playback.progress_ms) === null ? null : playback.progress_ms / 1000,
        durationSeconds: number(playback.track.duration_ms) === null ? null : playback.track.duration_ms / 1000,
      },
    });
  }
  return activities;
}

/** Face uses compact cards; simultaneous timer/music activities replace their physical screens. */
export function floatingActivityPlan({timers, spotify, now, destination = 'ready', panels = {}, maxCards = 3} = {}) {
  const activities = projectActivities({timers, spotify, now});
  const mode = isFacePresentation(destination) ? 'face' : 'body';
  const usesFloatingBody = mode === 'body' && activities.length > 1;
  const physicalPanels = Object.fromEntries(['left', 'right'].map(side =>
    [side, usesFloatingBody && ACTIVITY_TYPES.has(panels?.[side]?.type) ? null : panels?.[side] || null]));
  let resolvedDestination = destination;
  if (usesFloatingBody) {
    const sides = ['left', 'right'].filter(side => physicalPanels[side]);
    const thinking = destination.endsWith('Think');
    const base = destination.replace(/Think$/, '');
    if (!sides.length) resolvedDestination = thinking ? 'bodyThink' : 'ready';
    else {
      const retained = sides.length === 2 ? 'both'
        : panelSides(base).length === 1 && panelSides(base).includes(sides[0]) ? base : sides[0];
      resolvedDestination = retained + (thinking ? 'Think' : '');
    }
  }
  const represented = new Set(panelSides(destination).map(side => activityIdentity(physicalPanels[side])).filter(Boolean));
  const candidates = mode === 'face' || usesFloatingBody ? activities : activities.filter(activity => !represented.has(activity.id));
  const limit = Number.isSafeInteger(maxCards) && maxCards > 0 ? maxCards : 3;
  const cards = candidates.slice(0, limit);
  const music = candidates.find(activity => activity.type === 'music');
  // Keep music represented alongside timers; the remaining timers stay reachable through Activity.
  if (limit > 1 && music && !cards.includes(music)) cards[cards.length - 1] = music;
  const visibleIds = new Set(cards.map(card => card.id));
  const overflow = candidates.filter(activity => !visibleIds.has(activity.id));
  return {activities, cards, overflow, overflowCount: overflow.length, mode, usesFloatingBody, physicalPanels,
    destination: resolvedDestination, restorePanels: !usesFloatingBody};
}
