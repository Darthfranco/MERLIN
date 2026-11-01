import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MemoryStore } from '../memory-store.js';

// No SQLite here: the legacy engine loads this file, and must keep working without the v2 stack.
export const legacyPath = dataDir => join(dataDir, 'memory.json');
export const v2Dir = dataDir => join(dataDir, 'memory-v2');
const backupPath = dataDir => join(v2Dir(dataDir), 'backup', 'memory.json');

export async function writeAtomic(filePath, contents) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** A durable record of what was forgotten. Written before any deletion and reapplied at each startup of either engine. */
export class DeletionFence {
  #path; #dataDir; #state = { version: 1, entries: [] }; #queue = Promise.resolve();
  constructor(dataDir) { this.#dataDir = dataDir; this.#path = join(v2Dir(dataDir), 'fence.json'); }
  async init() {
    let contents;
    try { contents = await readFile(this.#path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return this; throw error; }
    try { this.#state = JSON.parse(contents); if (!Array.isArray(this.#state.entries)) throw new Error('Invalid entries.'); }
    catch (cause) { throw Object.assign(new Error('The memory deletion fence is unreadable; it was not overwritten. Inspect data/memory-v2/fence.json before restarting.', { cause }), { code: 'MEMORY_FENCE_CORRUPT' }); }
    return this;
  }
  #exclusive(work) { const result = this.#queue.then(work); this.#queue = result.catch(() => {}); return result; }
  #persist() { return writeAtomic(this.#path, `${JSON.stringify(this.#state, null, 2)}\n`); }
  get entries() { return this.#state.entries; }
  record(entry) {
    return this.#exclusive(async () => {
      const value = { seq: this.#state.entries.length + 1, at: new Date().toISOString(), applied_legacy: entry.origin === 'legacy', applied_backup: false, applied_v2: entry.origin !== 'legacy', ...entry };
      this.#state.entries.push(value);
      await this.#persist();
      return value;
    });
  }
  async #applyToFile(filePath, entry) {
    if (!existsSync(filePath)) return;
    const store = await new MemoryStore({ filePath }).init();
    if (entry.clear_all) { await store.clearAll(); return; }
    const snapshot = store.snapshot();
    for (const id of entry.ids ?? []) if (snapshot[entry.collection]?.some(item => item.id === id)) await store.remove({ collection: entry.collection, id });
    const remaining = new Set(store.snapshot().conversations.map(item => item.id));
    const sources = (entry.source_ids ?? []).filter(id => remaining.has(id));
    if (sources.length) await store.invalidateReferences({ source_ids: sources });
    if (entry.session_id && store.snapshot().conversations.some(item => item.session_id === entry.session_id)) await store.clearConversation(entry.session_id);
  }
  /** Makes rollback copies obey past deletions. Failure leaves the entry unapplied, so startup retries it. */
  applyToRollback() {
    return this.#exclusive(async () => {
      let changed = false;
      for (const entry of this.#state.entries) {
        try {
          if (!entry.applied_legacy) { await this.#applyToFile(legacyPath(this.#dataDir), entry); entry.applied_legacy = true; changed = true; }
          if (!entry.applied_backup) {
            if (entry.clear_all) await rm(join(v2Dir(this.#dataDir), 'backup'), { recursive: true, force: true });
            else await this.#applyToFile(backupPath(this.#dataDir), entry);
            entry.applied_backup = true; changed = true;
          }
        } catch { /* A damaged rollback copy is not overwritten. The entry stays unapplied and is retried at startup. */ }
      }
      if (changed) await this.#persist();
    });
  }
  async markAppliedToV2(entry) { return this.#exclusive(async () => { entry.applied_v2 = true; await this.#persist(); }); }
}

/** Legacy startup path: only when a v2 directory exists does any of this do anything. */
export async function openExistingFence(dataDir) {
  if (!existsSync(v2Dir(dataDir))) return null;
  return new DeletionFence(dataDir).init();
}
