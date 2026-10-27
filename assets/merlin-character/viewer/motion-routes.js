/** Authored transition graph shared by playback and the clock's look-ahead. */
export function transitionEdges(states, routes = []) {
  const edges = [];
  for (const [name, state] of Object.entries(states)) {
    if (state.parent && state.enter) edges.push({from: state.parent, to: name, clip: state.enter, phase: 'enter'});
    if (state.parent && state.exit) edges.push({from: name, to: state.exitTo || state.parent, clip: state.exit, phase: 'exit'});
    if (state.rest) edges.push({from: name, to: state.rest, clip: state.idle, phase: 'finishLoop'});
  }
  for (const edge of routes) edges.push({...edge, phase: edge.phase || 'transition'});
  return edges;
}

export function stateLineage(state, states) {
  const path = [];
  for (let current = state; current; current = states[current]?.parent) path.push(current);
  return path;
}
export const isFaceState = (state, states) => stateLineage(state, states).includes('face');

/** A remembered thought can return through its base when it has no direct face clip. */
function faceReturnHub(context, states, edges) {
  return stateLineage(context || 'ready', states).find(state =>
    edges.some(edge => edge.from === 'face' && edge.to === state)) || 'ready';
}

/** Fewest authored transitions; never invent an inverse or interrupt a clip. */
export function planRoute(from, to, states, routes = [], context = 'ready') {
  if (!states[from] || !states[to]) throw new RangeError('Unknown MERLIN route destination.');
  if (from === to) return [];
  const allEdges = transitionEdges(states, routes), returnHub = faceReturnHub(context, states, allEdges);
  const edges = allEdges.filter(edge => {
    // A full face is an excursion, never a shortcut between two body poses.
    if (edge.to === 'face' && !isFaceState(edge.from, states)) return isFaceState(to, states);
    if (edge.from === 'face' && !isFaceState(edge.to, states)) return edge.to === returnHub;
    return true;
  });
  const queue = [{state: from, path: []}], visited = new Set([from]);
  for (let i = 0; i < queue.length; i++) {
    for (const edge of edges.filter(edge => edge.from === queue[i].state)) {
      if (visited.has(edge.to)) continue;
      const path = [...queue[i].path, edge];
      if (edge.to === to) return path;
      visited.add(edge.to); queue.push({state: edge.to, path});
    }
  }
  throw new Error(`No authored MERLIN route from ${from} to ${to}.`);
}

const SURFACES = {
  left: ['left'], right: ['right'], both: ['left', 'right'],
  seatedLeft: ['left'], seatedRight: ['right'], camera: ['camera'], ceiling: ['right'],
};
export const stateScreens = state => SURFACES[state] || SURFACES[state?.replace(/Think$/, '')] || [];

/** The departing and arriving surfaces remain live throughout a transition. */
export function visibleScreens(motion) {
  return new Set([...stateScreens(motion.current), ...(motion.phase === 'idle' ? [] : stateScreens(motion.arrival))]);
}

/** Keep the seated arrangement when changing a screen that already belongs to it. */
export function contentDestination(motion, screen) {
  const candidates = [motion.desired, ...(motion.phase === 'idle' ? [] : [motion.arrival]), motion.current];
  const expanded = state => motion.states ? isFaceState(state,motion.states) : ['face','camera','faceThink','search'].includes(state);
  if(candidates.some(expanded))candidates.push(motion.bodyContext);
  const physical=screen==='ceiling'?'right':screen;
  return candidates.find(state => stateScreens(state).includes(physical)&&(screen!=='ceiling'||state?.replace(/Think$/,'')==='ceiling')) || screen;
}

export function dismissalDestination(state, side) {
  if (!['left', 'right', 'both'].includes(side)) throw new RangeError('Dismiss left, right, or both screens.');
  const panels = stateScreens(state).filter(screen => screen !== 'camera');
  if (!panels.length || (side !== 'both' && !panels.includes(side))) return state;
  if (side === 'both' || panels.length === 1) return 'ready';
  return side === 'left' ? 'seatedRight' : 'seatedLeft';
}
