import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60;
const MAX_RUNNING_TIMERS = 50;
const ARGUMENT_KEYS = ['label', 'duration_seconds', 'time_zone'];
const STORED_KEYS = new Set([
  'id', ...ARGUMENT_KEYS, 'created_at', 'ends_at', 'status', 'completed_at',
  'operation_key', 'dismissed',
]);

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_TIMER_ARGUMENT';
  return error;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateOperationKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw invalid('A timer operation key must be a nonempty string of at most 256 characters.');
  }
}

function validateArguments(value) {
  if (!object(value) || Object.keys(value).some((key) => !ARGUMENT_KEYS.includes(key))) {
    throw invalid('Timer arguments must contain only label, duration_seconds, and time_zone.');
  }
  if (typeof value.label !== 'string' || !value.label.trim() || value.label.trim().length > 80) {
    throw invalid('Timer label must contain 1 to 80 characters.');
  }
  if (!Number.isInteger(value.duration_seconds)
    || value.duration_seconds < 1 || value.duration_seconds > MAX_DURATION_SECONDS) {
    throw invalid('Timer duration_seconds must be an integer from 1 to 604800 (seven days).');
  }
  // Require a named zone. Some JS runtimes also accept fixed offsets here.
  if (typeof value.time_zone !== 'string' || value.time_zone.length > 100
    || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value.time_zone)) {
    throw invalid('Timer time_zone must be an explicit IANA time zone, such as America/New_York or UTC.');
  }
  let timeZone;
  try {
    timeZone = new Intl.DateTimeFormat('en-US', { timeZone: value.time_zone }).resolvedOptions().timeZone;
  } catch {
    throw invalid('Timer time_zone is not a recognized IANA time zone.');
  }
  return { label: value.label.trim(), duration_seconds: value.duration_seconds, time_zone: timeZone };
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validateState(state) {
  if (!object(state) || Object.keys(state).some((key) => !['version', 'timers'].includes(key))
    || state.version !== 1 || !Array.isArray(state.timers)) {
    throw new Error('Unsupported timer file structure or version.');
  }
  const ids = new Set();
  const operationKeys = new Set();
  for (const timer of state.timers) {
    if (!object(timer) || Object.keys(timer).some((key) => !STORED_KEYS.has(key))
      || typeof timer.id !== 'string' || !timer.id || timer.id.length > 100
      || ids.has(timer.id) || operationKeys.has(timer.operation_key)) {
      throw new Error('Invalid or duplicate stored timer.');
    }
    const args = validateArguments(Object.fromEntries(ARGUMENT_KEYS.map((key) => [key, timer[key]])));
    validateOperationKey(timer.operation_key);
    if (args.label !== timer.label || !validTimestamp(timer.created_at) || !validTimestamp(timer.ends_at)
      || Date.parse(timer.ends_at) - Date.parse(timer.created_at) !== timer.duration_seconds * 1000
      || !['running', 'completed', 'cancelled'].includes(timer.status)
      || typeof timer.dismissed !== 'boolean' || (timer.dismissed && timer.status === 'running')
      || (timer.status === 'completed' ? timer.completed_at !== timer.ends_at : 'completed_at' in timer)) {
      throw new Error('Invalid stored timer dates, arguments, or status.');
    }
    ids.add(timer.id);
    operationKeys.add(timer.operation_key);
  }
  if (state.timers.filter((timer) => timer.status === 'running').length > MAX_RUNNING_TIMERS) {
    throw new Error('Timer file exceeds the running timer limit.');
  }
}

function publicTimer(timer) {
  const { operation_key, dismissed, ...result } = timer;
  return result;
}

function completeDue(state, now) {
  const completed = [];
  for (const timer of state.timers) {
    if (timer.status === 'running' && Date.parse(timer.ends_at) <= now) {
      timer.status = 'completed';
      timer.completed_at = timer.ends_at;
      completed.push(publicTimer(timer));
    }
  }
  return completed;
}

/** A single-process persistent timer store. Share one instance per data file. */
export class TimerStore {
  #filePath;
  #now;
  #state;
  #queue = Promise.resolve();

  constructor({ filePath, now = Date.now } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim() || typeof now !== 'function') {
      throw invalid('TimerStore requires filePath and an optional clock function.');
    }
    this.#filePath = resolve(filePath);
    this.#now = now;
  }

  #enqueue(action) {
    const result = this.#queue.then(action);
    // A failed operation must not poison future operations.
    this.#queue = result.catch(() => {});
    return result;
  }

  #timestamp() {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) {
      throw new Error('Timer clock must return a valid integer Unix timestamp in milliseconds.');
    }
    return now;
  }

  #requireInitialized() {
    if (!this.#state) throw new Error('TimerStore.init() must succeed before using timers.');
  }

  async #persist(state) {
    const directory = dirname(this.#filePath);
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
    let handle;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#filePath);
    } catch (cause) {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      const error = new Error('Could not save timers; the requested change was not applied.', { cause });
      error.code = 'TIMER_STORAGE_ERROR';
      throw error;
    }
  }

  async init() {
    return this.#enqueue(async () => {
      if (this.#state) return this;
      let state;
      let missing = false;
      let contents;
      try {
        contents = await readFile(this.#filePath, 'utf8');
      } catch (cause) {
        if (cause.code !== 'ENOENT') {
          throw new Error('Could not read the timer file.', { cause });
        }
        missing = true;
      }
      if (missing) state = { version: 1, timers: [] };
      else {
        try {
          state = JSON.parse(contents);
          validateState(state);
        } catch (cause) {
          const error = new Error('The timer file is invalid or corrupted; it was not overwritten. Restore or move it before restarting.', { cause });
          error.code = 'TIMER_STORAGE_CORRUPT';
          throw error;
        }
      }
      // Reconcile offline expiry once, before exposing state. No replayed alarms.
      const completed = completeDue(state, this.#timestamp());
      if (missing || completed.length) await this.#persist(state);
      this.#state = state;
      return this;
    });
  }

  async create(value, operationKey) {
    return this.#enqueue(async () => {
      this.#requireInitialized();
      const args = validateArguments(value);
      validateOperationKey(operationKey);
      const existing = this.#state.timers.find((timer) => timer.operation_key === operationKey);
      if (existing) {
        if (ARGUMENT_KEYS.some((key) => existing[key] !== args[key])) {
          throw invalid('This timer operation key was already used with different arguments.');
        }
        return publicTimer(existing);
      }
      const state = structuredClone(this.#state);
      const now = this.#timestamp();
      completeDue(state, now);
      if (state.timers.filter((timer) => timer.status === 'running').length >= MAX_RUNNING_TIMERS) {
        throw invalid('At most 50 timers can run at once. Cancel a timer before starting another.');
      }
      const timer = {
        id: randomUUID(), ...args,
        created_at: new Date(now).toISOString(),
        ends_at: new Date(now + args.duration_seconds * 1000).toISOString(),
        status: 'running', operation_key: operationKey, dismissed: false,
      };
      state.timers.push(timer);
      await this.#persist(state);
      this.#state = state;
      return publicTimer(timer);
    });
  }

  async list() {
    return this.#enqueue(() => {
      this.#requireInitialized();
      return this.#state.timers.filter((timer) => !timer.dismissed).map(publicTimer);
    });
  }

  async cancel(id) {
    return this.#enqueue(async () => {
      this.#requireInitialized();
      const state = structuredClone(this.#state);
      const timer = this.#find(state, id);
      const completed = completeDue(state, this.#timestamp());
      const changed = timer.status === 'running';
      if (changed) timer.status = 'cancelled';
      if (changed || completed.length) {
        await this.#persist(state);
        this.#state = state;
      }
      return publicTimer(timer);
    });
  }

  async dismiss(id) {
    return this.#enqueue(async () => {
      this.#requireInitialized();
      const state = structuredClone(this.#state);
      const timer = this.#find(state, id);
      const completed = completeDue(state, this.#timestamp());
      if (timer.status === 'running') throw invalid('Cancel a running timer before dismissing it.');
      if (!timer.dismissed || completed.length) {
        timer.dismissed = true;
        await this.#persist(state);
        this.#state = state;
      }
      return publicTimer(timer);
    });
  }

  #find(state, id) {
    if (typeof id !== 'string' || !id.trim()) throw invalid('Timer id must be a nonempty string.');
    const timer = state.timers.find((entry) => entry.id === id);
    if (!timer) {
      const error = new Error('Timer not found.');
      error.code = 'TIMER_NOT_FOUND';
      throw error;
    }
    return timer;
  }

  async tick() {
    return this.#enqueue(async () => {
      this.#requireInitialized();
      const state = structuredClone(this.#state);
      const completed = completeDue(state, this.#timestamp());
      if (completed.length) {
        await this.#persist(state);
        this.#state = state;
      }
      return completed;
    });
  }
}
