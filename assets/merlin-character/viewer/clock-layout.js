import {planRoute,transitionEdges} from './motion-routes.js';

/** Five resting places, in scene coordinates. No model calls or frame-by-frame chasing. */
export const CLOCK_SPOTS = ['upper-left', 'upper-middle', 'upper-right', 'lower-left', 'lower-right'];
// These complete paired movements sweep through every reserved anchor. Their
// seated/ready endpoints are clear, so time returns as soon as the clip ends.
const BUSY_TRANSITIONS = new Set(['ReadyToBothPanels', 'BothPanelsToReady']);
const REPLAN_HUBS = new Set(['ready', 'seatedLeft', 'seatedRight']);

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
export function clockMotionPlan(motion, states, routes = motion.routes || []) {
  const coversStage = state => {const path=lineage(state,states);return path.includes('face')||path.includes('ceiling');};
  const hidden = coversStage(motion.current) || (motion.phase !== 'idle' && (coversStage(motion.arrival) || BUSY_TRANSITIONS.has(motion.clip)));
  const clips = new Set([motion.clip]);
  let cursor = motion.phase === 'idle' ? motion.current : motion.arrival;
  if(motion.phase==='finishLoop')cursor=motion.current===motion.desired?motion.current:(states[cursor].rest||cursor);
  const pending = planRoute(cursor, motion.desired, states, routes, motion.bodyContext);
  for (const edge of pending) clips.add(edge.clip);
  clips.add(states[motion.desired].idle);
  if(states[motion.desired].rest)clips.add(states[states[motion.desired].rest].idle);
  const hiddenClips = new Set(Object.entries(states).filter(([state]) => coversStage(state))
    .flatMap(([, state]) => [state.enter, state.idle, state.exit]));
  for(const edge of transitionEdges(states,routes))if(coversStage(edge.from)||coversStage(edge.to))hiddenClips.add(edge.clip);
  for(const clip of BUSY_TRANSITIONS)hiddenClips.add(clip);
  const route = [...clips].filter(Boolean);
  const activity = motion.phase === 'enter' ? motion.arrival : motion.current;
  // Ready and completed seated dismissals are safe replanning points. Panels occupy both
  // halves at different times: reserve the old panel through its dismissal,
  // then move ahead of the next action. Combining them would block every slot.
  const leavingActivity = activity !== 'ready' && !coversStage(activity) &&
    (activity !== motion.desired || motion.phase !== 'idle' && motion.arrival !== activity);
  let segment = route;
  if (leavingActivity) {
    const reserved = new Set([motion.clip, states[activity].idle]);
    let hub = motion.phase !== 'idle' && REPLAN_HUBS.has(motion.arrival) ? motion.arrival : null;
    if (!hub) for (const edge of pending) {
      reserved.add(edge.clip);
      if (REPLAN_HUBS.has(edge.to)) {hub = edge.to; break;}
    }
    if(hub && hub !== 'ready')reserved.add(states[hub].idle);
    if (!hub) {
      reserved.add(states[motion.desired].idle);
      if(states[motion.desired].rest)reserved.add(states[states[motion.desired].rest].idle);
    }
    segment = [...reserved];
  }
  // A future full-frame face or ceiling screen must not evict a still-visible walking clock;
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
