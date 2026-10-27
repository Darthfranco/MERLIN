/** Five resting places, in scene coordinates. No model calls or frame-by-frame chasing. */
export const CLOCK_SPOTS = ['upper-left', 'upper-middle', 'upper-right', 'lower-left', 'lower-right'];

export function clockAnchors(width, height, clockWidth, clockHeight) {
  const inset = Math.min(width, height) * .055;
  const left = inset, right = Math.max(left, width - inset - clockWidth);
  const top = inset, bottom = Math.max(top, height - inset - clockHeight);
  return [
    [left, top], [(width - clockWidth) / 2, top], [right, top], [left, bottom], [right, bottom],
  ].map(([x, y], i) => ({id: CLOCK_SPOTS[i], x, y, width: clockWidth, height: clockHeight}));
}

function lineage(state, states) {
  const path = [];
  for (let s = state; s; s = states[s]?.parent) path.push(s);
  return path;
}

/** Include every queued transition AND the destination's entire idle loop. */
export function clockMotionPlan(motion, states) {
  const inFace = state => lineage(state, states).includes('face');
  const hidden = inFace(motion.current) || (motion.phase !== 'idle' && inFace(motion.arrival));
  const clips = new Set([motion.clip]);
  let cursor = motion.phase === 'idle' ? motion.current : motion.arrival;
  const destination = lineage(motion.desired, states);
  while (cursor && !destination.includes(cursor)) {
    clips.add(states[cursor].exit);
    cursor = states[cursor].parent;
  }
  const entering = destination.slice(0, destination.indexOf(cursor)).reverse();
  for (const state of entering) clips.add(states[state].enter);
  clips.add(states[motion.desired].idle);
  const hiddenClips = new Set(Object.entries(states).filter(([state]) => inFace(state))
    .flatMap(([, state]) => [state.enter, state.idle, state.exit]));
  const route = [...clips].filter(Boolean);
  const activity = motion.phase === 'enter' ? motion.arrival : motion.current;
  // The ready hub is a safe replanning point. Opposite panels occupy both
  // halves at different times: reserve the old panel through its dismissal,
  // then move ahead of the next pull. Combining them would block every slot.
  const leavingActivity = states[activity]?.parent === 'ready' && !inFace(activity) && activity !== motion.desired;
  const segment = leavingActivity ? [...new Set([motion.clip, states[activity].idle, states[activity].exit])] : route;
  // A future full-screen face must not evict a still-visible walking clock;
  // time will already be hidden by the time those clips start.
  return {hidden, clips: route, occlusionClips: segment.filter(clip => clip && !hiddenClips.has(clip))};
}

export function overlapArea(a, b) {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

export function chooseClockSpot({width, height, clockWidth, clockHeight, obstacles = [], current}) {
  const clearance = Math.min(width, height) * .018;
  const candidates = clockAnchors(width, height, clockWidth, clockHeight).map(anchor => {
    const rect = {left: anchor.x - clearance, top: anchor.y - clearance,
      right: anchor.x + clockWidth + clearance, bottom: anchor.y + clockHeight + clearance};
    const overlap = obstacles.reduce((sum, b) => sum + overlapArea(rect, {
      left: b.left * width, right: b.right * width, top: b.top * height, bottom: b.bottom * height,
    }), 0) / (clockWidth * clockHeight);
    return {...anchor, overlap};
  });
  const held = candidates.find(a => a.id === current);
  // Stable whenever safe. A minor score change never makes an obstructed clock oscillate.
  if (held?.overlap === 0) return held;
  const best = [...candidates].sort((a, b) => a.overlap - b.overlap)[0];
  return held && best.overlap > 0 && held.overlap <= best.overlap + .08 ? held : best;
}

export function formatSceneTime(date, locale, timeZone) {
  const options = timeZone ? {timeZone} : {};
  const parts = new Intl.DateTimeFormat(locale, {...options, hour: 'numeric', minute: '2-digit'}).formatToParts(date);
  return {
    time: parts.filter(p => p.type !== 'dayPeriod').map(p => p.value).join('').trim(),
    period: parts.find(p => p.type === 'dayPeriod')?.value || '',
    date: new Intl.DateTimeFormat(locale, {...options, weekday: 'short', month: 'short', day: 'numeric'}).format(date),
    label: new Intl.DateTimeFormat(locale, {...options, dateStyle: 'full', timeStyle: 'short'}).format(date),
  };
}
