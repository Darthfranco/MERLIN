import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CONNECTIONS } from '../public/connections/catalog.js';
import { AppError } from './errors.js';

const ROUTES = new Map(CONNECTIONS.map(route => [route.id, route]));

/**
 * Preview connections: catalog IDs the household marked as connected on the large
 * screen. They record a choice only. Nothing is authenticated, discovered, or
 * controlled, and a preview connection never authorizes a device action.
 */
export class ConnectionStore {
  #filePath;
  #now;
  #state;
  #queue = Promise.resolve();

  constructor({ filePath, now = () => new Date().toISOString() } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim() || typeof now !== 'function') throw new Error('ConnectionStore requires a filePath.');
    this.#filePath = resolve(filePath);
    this.#now = now;
  }

  #enqueue(action) {
    const result = this.#queue.then(action);
    this.#queue = result.catch(() => {});
    return result;
  }

  #ready() { if (!this.#state) throw new Error('ConnectionStore.init() must succeed first.'); }

  async #persist(state) {
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
    let handle;
    try {
      await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#filePath);
      await chmod(this.#filePath, 0o600).catch(() => {});
    } catch {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      throw new AppError('Could not save the connection choice; nothing changed.', 500);
    }
  }

  async init() {
    return this.#enqueue(async () => {
      if (this.#state) return this;
      let contents;
      try { contents = await readFile(this.#filePath, 'utf8'); }
      catch (cause) {
        if (cause.code !== 'ENOENT') throw new Error('Could not read the connections file.', { cause });
      }
      if (contents === undefined) { this.#state = { version: 1, connections: [] }; return this; }
      let parsed;
      try { parsed = JSON.parse(contents); } catch (cause) { throw new Error('The connections file is not valid JSON.', { cause }); }
      const entries = Array.isArray(parsed?.connections) ? parsed.connections : null;
      if (parsed?.version !== 1 || !entries) throw new Error('The connections file has an unsupported format.');
      // Unknown or restricted IDs are dropped instead of trusted.
      const seen = new Set();
      this.#state = { version: 1, connections: entries.filter(entry => {
        const ok = typeof entry?.id === 'string' && ROUTES.get(entry.id)?.availability !== 'restricted' && ROUTES.has(entry.id) && !seen.has(entry.id)
          && typeof entry.connected_at === 'string' && !Number.isNaN(Date.parse(entry.connected_at));
        if (ok) seen.add(entry.id);
        return ok;
      }).map(({ id, connected_at }) => ({ id, connected_at })) };
      return this;
    });
  }

  list() { this.#ready(); return this.#state.connections.map(entry => ({ ...entry })); }
  ids() { return this.list().map(entry => entry.id); }

  #route(id) {
    const route = typeof id === 'string' ? ROUTES.get(id) : undefined;
    if (!route) throw new AppError('Choose a connection from the list.', 400);
    return route;
  }

  async connect(id) {
    const route = this.#route(id);
    if (route.availability === 'restricted') throw new AppError(`${route.name} has no supported route to connect right now.`, 409);
    return this.#enqueue(async () => {
      this.#ready();
      const existing = this.#state.connections.find(entry => entry.id === id);
      if (existing) return { ...existing };
      const record = { id, connected_at: this.#now() };
      await this.#persist({ ...this.#state, connections: [...this.#state.connections, record] });
      this.#state = { ...this.#state, connections: [...this.#state.connections, record] };
      return { ...record };
    });
  }

  async disconnect(id) {
    this.#route(id);
    return this.#enqueue(async () => {
      this.#ready();
      if (!this.#state.connections.some(entry => entry.id === id)) return false;
      const next = { ...this.#state, connections: this.#state.connections.filter(entry => entry.id !== id) };
      await this.#persist(next);
      this.#state = next;
      return true;
    });
  }

  async clear() {
    return this.#enqueue(async () => {
      this.#ready();
      const next = { version: 1, connections: [] };
      await this.#persist(next);
      this.#state = next;
    });
  }
}
