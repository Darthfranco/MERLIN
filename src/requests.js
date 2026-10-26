import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { AppError } from './errors.js';

// A durable receipt is written BEFORE work begins. It contains hashes, not chat.
// After restart, a seen request is refused instead of risking a repeated action.
export class RequestLedger {
  constructor(filePath) { this.filePath = filePath; this.seen = new Map(); this.live = new Map(); this.queue = Promise.resolve(); }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const contents = await readFile(this.filePath, 'utf8');
      for (const line of contents.split('\n').filter(Boolean)) {
        const item = JSON.parse(line);
        if (!/^[a-f0-9]{64}$/.test(item.id) || !/^[a-f0-9]{64}$/.test(item.fingerprint)) throw new Error('Invalid receipt');
        this.seen.set(item.id, item.fingerprint);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Request receipt storage is unreadable. Preserve the data file and inspect it before restarting.');
    }
    return this;
  }

  async run(id, body, work) {
    const hash = value => createHash('sha256').update(value).digest('hex');
    const key = hash(id);
    const fingerprint = hash(JSON.stringify(body));
    const reserve = this.queue.then(async () => {
      if (this.seen.has(key)) {
        if (this.seen.get(key) !== fingerprint) throw new AppError('This request ID was already used for different input.', 409);
        if (!this.live.has(key)) throw new AppError('This request was already attempted before a server restart or cache expiry. Check the timers before sending a new request.', 409);
        return;
      }
      await appendFile(this.filePath, `${JSON.stringify({ id: key, fingerprint })}\n`, { mode: 0o600, flush: true });
      this.seen.set(key, fingerprint);
      // Install the promise while still holding the reservation queue.
      const task = Promise.resolve().then(work);
      task.catch(() => {});
      this.live.set(key, task);
      // Bound in-memory response retention. Durable hashes still prevent replay.
      const expiry = setTimeout(() => this.live.delete(key), 60 * 60 * 1000);
      expiry.unref();
    });
    this.queue = reserve.catch(() => {});
    await reserve;
    return this.live.get(key);
  }
}
