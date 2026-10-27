import {chooseOverlaySpot, companionOverlayRail} from './layout.js';
import {normalizeOverlay, formatOverlayDuration} from './model.js';

const paths = {
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="m9 5 10 7-10 7Z"/>',
};
function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}
const record = '<svg class="floating-record" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="31" fill="#16334b"/><g fill="none" stroke="#546d7f"><circle cx="32" cy="32" r="24"/><circle cx="32" cy="32" r="19"/></g><circle cx="32" cy="32" r="12" fill="#8bd9f2"/><circle cx="32" cy="32" r="3" fill="#16334b"/></svg>';
const labels = {running: 'Counting down', paused: 'Paused', finished: 'Time’s up', playing: 'Playing', stopped: 'Stopped', loading: 'Loading', error: 'Unavailable', unknown: 'Status unavailable'};

/** Optional presentation only. No timer, playback, service call, persistence, or demo defaults. */
export class SceneOverlays {
  constructor(stage, {clock, onChange = () => {}, presentation = 'studio'} = {}) {
    if (!stage || !clock?.subscribeLayout) throw new TypeError('Floating overlays need a stage and its SceneClock.');
    if (typeof onChange !== 'function') throw new TypeError('onChange must be a function.');
    if (!['studio', 'companion'].includes(presentation)) throw new TypeError('Choose the studio or companion overlay presentation.');
    this.stage = stage;
    this.presentation = presentation;
    this.mode = 'body';
    this.onChange = onChange;
    this.cards = new Map();
    if (presentation === 'companion') {
      this.rail = document.createElement('section');
      this.rail.className = 'floating-rail'; this.rail.dataset.presentation = this.mode; this.rail.hidden = true;
      this.rail.tabIndex = 0; this.rail.setAttribute('role', 'region');
      this.rail.setAttribute('aria-label', 'Active timers and music. Scroll for more.');
      stage.append(this.rail);
    }
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.observer = new ResizeObserver(() => this.place(true));
    this.unsubscribe = clock.subscribeLayout(layout => { this.layout = layout; this.place(layout.resize); });
  }

  show(type, data = {}, {id = type, onAction} = {}) {
    if (this.destroyed) throw new Error('The floating overlays have been destroyed.');
    if (typeof id !== 'string' || !id.trim()) throw new TypeError('An overlay needs a nonempty string id.');
    if (onAction !== undefined && typeof onAction !== 'function') throw new TypeError('onAction must be a function.');
    const state = normalizeOverlay(type, data);
    const previous = this.cards.get(id);
    if (previous && previous.type !== type) throw new TypeError('Use a different id for a different overlay type.');
    let card = previous;
    if (!card) {
      const element = document.createElement('section');
      element.className = 'floating-overlay'; element.dataset.type = type; element.dataset.overlayId = id;
      element.dataset.visible = 'false'; element.setAttribute('aria-hidden', 'true'); element.inert = true;
      // Only authored markup goes through innerHTML. All supplied data uses textContent.
      element.innerHTML = `<div class="floating-content">${type === 'music' ? record : ''}<div class="floating-copy"><p class="floating-title"></p>${type === 'timer' ? '<p class="floating-countdown"></p>' : '<p class="floating-artist"></p>'}<p class="floating-status"></p></div><button class="floating-action" type="button" hidden></button></div><progress class="floating-progress" max="1" hidden></progress>`;
      card = {id, type, element};
      card.button = element.querySelector('button');
      card.button.addEventListener('click', () => {
        // The caller owns execution and the next state. Never claim a successful action here.
        if (!this.destroyed && this.cards.get(id) === card && element.dataset.visible === 'true' &&
            !card.button.hidden && !card.button.disabled && card.onAction) card.onAction({id, type, action: card.action});
      });
      this.cards.set(id, card); (this.rail || this.stage).append(element); this.observer.observe(element);
    }
    card.data = {...data}; card.state = state; card.onAction = onAction;
    this.paint(card); this.place();
    return id;
  }

  update(id, patch) {
    const card = this.cards.get(id);
    if (!card) return false;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Overlay data must be an object.');
    this.show(card.type, {...card.data, ...patch}, {id, onAction: card.onAction});
    return true;
  }

  hide(id) {
    const card = this.cards.get(id);
    if (!card) return false;
    card.movement?.cancel(); this.observer.unobserve(card.element); card.element.remove();
    this.cards.delete(id); this.place(); return true;
  }

  clear() { for (const id of [...this.cards.keys()]) this.hide(id); }

  setPresentation(mode) {
    if (!['body', 'face', 'hidden'].includes(mode)) throw new TypeError('Choose body, face, or hidden overlay presentation.');
    if (this.destroyed || this.mode === mode) return;
    this.mode = mode;
    if (this.rail) this.rail.dataset.presentation = mode;
    for (const card of this.cards.values()) this.paint(card);
    this.place(true);
  }

  get status() {
    return [...this.cards.values()].map(card => ({id: card.id, type: card.type,
      visible: card.element.dataset.visible === 'true', spot: card.spot?.id ?? null,
      reason: card.reason}));
  }

  paint(card) {
    const {element, state, type} = card;
    const set = (selector, text) => { const node = element.querySelector(selector); if (node.textContent !== text) node.textContent = text; };
    set('.floating-title', state.title); element.querySelector('.floating-title').title = state.title;
    set('.floating-status', labels[state.status]); element.dataset.status = state.status;
    if (type === 'timer') {
      const countdown = formatOverlayDuration(state.remainingSeconds);
      set('.floating-countdown', countdown); element.dataset.long = String(countdown.length > 5);
    }
    else { set('.floating-artist', state.artist); element.querySelector('.floating-artist').title = state.artist; }
    element.setAttribute('aria-label', type === 'timer' ? `Timer: ${state.title}, ${formatOverlayDuration(state.remainingSeconds)}, ${labels[state.status]}` :
      `Music: ${state.title}${state.artist ? ', ' + state.artist : ''}, ${labels[state.status]}`);
    const active = state.status === 'running' || state.status === 'playing';
    card.action = active ? 'pause' : 'resume';
    card.button.hidden = !card.onAction || this.presentation === 'companion' && this.mode === 'face';
    card.button.disabled = !active && state.status !== 'paused';
    card.button.setAttribute('aria-label', `${active ? 'Pause' : 'Resume'} ${type === 'timer' ? state.title : 'music'}`);
    const symbol = active ? 'pause' : 'play';
    if (card.button.dataset.symbol !== symbol) { card.button.innerHTML = icon(symbol); card.button.dataset.symbol = symbol; }
    const position = type === 'timer' ? state.remainingSeconds : state.positionSeconds;
    const progress = element.querySelector('progress');
    progress.hidden = !(position !== null && state.durationSeconds > 0);
    if (!progress.hidden) progress.value = Math.min(1, Math.max(0, position / state.durationSeconds));
    progress.setAttribute('aria-label', type === 'timer' ? 'Time remaining' : 'Track progress');
  }

  place(resize = false) {
    if (!this.layout || this.destroyed) return;
    const {width, height, obstacles, clock, hidden} = this.layout;
    if (this.rail) {
      const target = companionOverlayRail({width, height, mode: this.mode, clock: hidden ? null : clock, obstacles, current: this.railSpot?.id});
      const visible = Boolean(target && this.cards.size);
      this.rail.hidden = !visible; this.rail.inert = !visible;
      if (target) {
        this.railSpot = target;
        this.rail.style.left = `${target.x}px`; this.rail.style.bottom = `${target.bottom}px`;
        this.rail.style.width = `${target.width}px`; this.rail.style.maxHeight = `${target.maxHeight}px`;
      }
      for (const card of this.cards.values()) {
        card.element.dataset.visible = String(visible); card.element.setAttribute('aria-hidden', String(!visible));
        card.element.inert = !visible; card.reason = visible ? null : 'presentation';
        card.spot = target; card.element.dataset.spot = target?.id || '';
      }
      this.onChange(this.status); return;
    }
    const reserved = clock ? [clock] : [];
    for (const card of this.cards.values()) {
      const target = hidden ? null : chooseOverlaySpot({width, height, obstacles, reserved,
        cardWidth: card.element.offsetWidth, cardHeight: card.element.offsetHeight, current: card.spot?.id});
      const visible = Boolean(target), wasVisible = card.element.dataset.visible === 'true';
      card.element.dataset.visible = String(visible); card.element.setAttribute('aria-hidden', String(!visible));
      card.element.inert = !visible; card.reason = visible ? null : hidden ? 'presentation' : 'space';
      if (!target) { card.movement?.cancel(); continue; }
      reserved.push(target);
      if (!resize && target.x === card.spot?.x && target.y === card.spot?.y) continue;
      const from = getComputedStyle(card.element).transform;
      card.movement?.cancel();
      const transform = `translate(${target.x}px, ${target.y}px)`;
      card.element.style.transform = transform;
      if (wasVisible && !resize && !this.reducedMotion.matches) {
        card.movement = card.element.animate([{transform: from}, {transform}], {duration: 320, easing: 'cubic-bezier(.16, 1, .3, 1)'});
      }
      card.spot = target; card.element.dataset.spot = target.id;
    }
    this.onChange(this.status);
  }

  destroy() { this.clear(); this.destroyed = true; this.unsubscribe(); this.observer.disconnect(); this.rail?.remove(); }
}
