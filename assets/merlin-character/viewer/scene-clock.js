import {chooseClockSpot, clockMotionPlan, formatSceneTime} from './clock-layout.js';

/** A lightweight DOM overlay; only re-plan on route, viewport, or type-size changes. */
export class SceneClock {
  constructor(stage, states, footprints, routes = []) {
    this.stage = stage;
    this.states = states;
    this.routes = routes;
    this.footprints = footprints;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.element = document.createElement('div');
    this.element.className = 'scene-clock';
    this.element.id = 'scene-clock';
    this.element.dataset.visible = 'false';
    this.element.innerHTML = '<time class="scene-clock-time"><span class="scene-clock-digits"></span><span class="scene-clock-period"></span></time><span class="scene-clock-date"></span>';
    this.time = this.element.querySelector('time');
    stage.append(this.element);
    this.updateTime();
    this.observer = new ResizeObserver(() => this.place(true));
    this.observer.observe(stage);
    this.observer.observe(this.element);
    this.onVisibility = () => { if (!document.hidden) this.updateTime(); };
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  updateTime() {
    clearTimeout(this.timer);
    const now = new Date();
    const text = formatSceneTime(now, navigator.language);
    this.element.querySelector('.scene-clock-digits').textContent = text.time;
    this.element.querySelector('.scene-clock-period').textContent = text.period;
    this.element.querySelector('.scene-clock-date').textContent = text.date;
    this.element.setAttribute('aria-label', text.label);
    this.time.dateTime = now.toISOString();
    // Wall time is independent of animation pause. Refresh promptly after sleep/clock changes.
    this.timer = setTimeout(() => this.updateTime(), Math.min(15000, 60000 - now.getTime() % 60000 + 20));
  }

  sync(motion) {
    this.motion = motion;
    this.plan = clockMotionPlan(motion, this.states, this.routes);
    const visible = !this.plan.hidden;
    this.element.dataset.visible = String(visible);
    this.element.setAttribute('aria-hidden', String(!visible));
    this.place();
  }

  place(resize = false) {
    if (!this.plan) return;
    const width = this.stage.clientWidth, height = this.stage.clientHeight;
    const clockWidth = this.element.offsetWidth, clockHeight = this.element.offsetHeight;
    if (!width || !height || !clockWidth || !clockHeight) return;
    const obstacles = this.plan.occlusionClips.flatMap(clip => this.footprints.get(clip) || []);
    const target = chooseClockSpot({width, height, clockWidth, clockHeight, obstacles, current: this.spot?.id});
    if (!resize && this.spot?.x === target.x && this.spot?.y === target.y) return;
    const from = getComputedStyle(this.element).transform;
    this.movement?.cancel();
    const transform = `translate(${target.x}px, ${target.y}px)`;
    this.element.style.transform = transform;
    if (this.spot && !resize && !this.plan.hidden && !this.reducedMotion.matches) {
      this.movement = this.element.animate([{transform: from}, {transform}], {
        duration: 320, easing: 'cubic-bezier(.16, 1, .3, 1)',
      });
    }
    this.spot = target;
    this.element.dataset.spot = target.id;
  }

  destroy() {
    clearTimeout(this.timer);
    this.movement?.cancel();
    this.observer.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.element.remove();
  }
}
