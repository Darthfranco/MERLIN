/** Serialize notification delivery; accepting audio never authorizes another action. */
export class TimerAlertQueue {
  constructor({now = () => Date.now()} = {}) {
    this.now = now;
    this.pending = new Map();
    this.active = null;
  }
  enqueue(timer) {
    if (!this.pending.has(timer.id) && this.active?.id !== timer.id) {
      this.pending.set(timer.id, {timer, attempts: 0, retryAt: 0});
    }
  }
  claim(ready) {
    this.expire();
    if (!ready || this.active) return null;
    for (const [id, item] of this.pending) {
      if (item.retryAt > this.now()) continue;
      item.attempts++;
      return this.active = {id, timer: item.timer, accepted: false, deadline: null};
    }
    return null;
  }
  waiting(token) {
    if (this.active === token) token.deadline = this.now() + 10_000;
  }
  accept(token) {
    if (this.active !== token) return false;
    token.accepted = true; token.deadline = null;
    this.pending.delete(token.id);
    return true;
  }
  release(token, {retry = false} = {}) {
    if (!token || this.active !== token) return false;
    const item = this.pending.get(token.id);
    if (retry && !token.accepted && item) {
      item.retryAt = this.now() + Math.min(10_000, 1000 * 2 ** Math.min(item.attempts - 1, 4));
    } else this.pending.delete(token.id);
    this.active = null;
    return true;
  }
  interrupt() { this.release(this.active, {retry: true}); }
  expire() {
    if (this.active && this.active.deadline !== null && this.now() >= this.active.deadline) {
      this.release(this.active, {retry: true});
    }
  }
}
