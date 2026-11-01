import { join } from 'node:path';
import { MemoryStore } from './memory-store.js';
import { MemoryService } from './memory.js';
import { MemoryLearning } from './memory-learning.js';
import { DeletionFence, openExistingFence, v2Dir } from './memory-v2/fence.js';

// Legacy stays the default until a real embedding service is verified for v2; see docs/MEMORY_V2.md.
export const DEFAULT_MEMORY_ENGINE = 'legacy';

export function selectedEngine(value = process.env.MERLIN_MEMORY_ENGINE) {
  const engine = value || DEFAULT_MEMORY_ENGINE;
  if (!['legacy', 'v2'].includes(engine)) throw new Error('MERLIN_MEMORY_ENGINE must be v2 or legacy.');
  return engine;
}

function configuredEmbedder(OllamaEmbedder) {
  if (process.env.MERLIN_EMBEDDING_PROVIDER === 'none') return null;
  return new OllamaEmbedder({
    baseUrl: process.env.MERLIN_EMBEDDING_URL || undefined,
    model: process.env.MERLIN_EMBEDDING_MODEL || undefined,
    ...(process.env.MERLIN_EMBEDDING_QUERY_TIMEOUT_MS ? { queryTimeoutMs: Number(process.env.MERLIN_EMBEDDING_QUERY_TIMEOUT_MS) } : {}),
  });
}

/** Builds exactly one engine. Only the selected engine's worker exists, and the other's storage is left alone. */
export async function createMemoryEngine({ engine, dataDir, meta, suppliedStore, learningDelayMs = 750, options = {} }) {
  const kind = selectedEngine(engine);
  if (kind === 'legacy') {
    const fence = await openExistingFence(dataDir);
    // Deletions made while v2 was active must hold before this store is read.
    await fence?.applyToRollback();
    const store = suppliedStore || await new MemoryStore({ filePath: join(dataDir, 'memory.json') }).init();
    const memory = new MemoryService(store, { fence });
    const learning = await new MemoryLearning({ store, meta, filePath: join(dataDir, 'memory-learning.json'), delayMs: learningDelayMs }).init();
    return { kind, store, memory, learning, attachRoutines() {} };
  }
  try {
    // Loaded only when selected: the backup engine does not depend on node:sqlite.
    const [{ openDatabase }, { EmbeddingGate, OllamaEmbedder }, { CLOSE_AFTER_MS, MemoryLifecycle }, { migrateLegacy }, { DEFAULT_SEMANTIC_CUTOFF, Retriever }, { MemoryServiceV2 }] = await Promise.all([
      import('./memory-v2/db.js'), import('./memory-v2/embeddings.js'), import('./memory-v2/lifecycle.js'), import('./memory-v2/migration.js'), import('./memory-v2/retrieval.js'), import('./memory-v2/service.js'),
    ]);
    const directory = v2Dir(dataDir);
    const db = openDatabase(join(directory, 'memory.sqlite'));
    const sourcesPath = join(directory, 'sources.json');
    const fence = await new DeletionFence(dataDir).init();
    await migrateLegacy({ dataDir, db, sourcesPath });
    const store = await new MemoryStore({ filePath: sourcesPath }).init();
    const gate = new EmbeddingGate(options.embedder === undefined ? configuredEmbedder(OllamaEmbedder) : options.embedder);
    const cutoff = Number(process.env.MERLIN_MEMORY_SEMANTIC_CUTOFF);
    const retriever = new Retriever({ db, gate, semanticCutoff: options.semanticCutoff ?? (Number.isFinite(cutoff) && process.env.MERLIN_MEMORY_SEMANTIC_CUTOFF ? cutoff : DEFAULT_SEMANTIC_CUTOFF) });
    const closeSeconds = Number(process.env.MERLIN_MEMORY_CLOSE_SECONDS);
    const learning = new MemoryLifecycle({ db, store, meta, gate, clock: options.clock, tickMs: options.tickMs ?? 1000, failpoints: options.failpoints,
      closeAfterMs: options.closeAfterMs ?? (closeSeconds > 0 ? closeSeconds * 1000 : CLOSE_AFTER_MS),
      onDeletionSweep: () => { void memory.syncRollbackSources().catch(() => {}); } });
    const memory = new MemoryServiceV2({ store, db, retriever, lifecycle: learning, fence, dataDir });
    // Finish anything a crash interrupted, and bring in deletions made under legacy, before serving.
    await fence.applyToRollback();
    await memory.reconcileRollbackDeletions();
    await memory.syncRollbackSources();
    learning.reconcileCompleted();
    if (gate.configured) void gate.check();
    return { kind, store, memory, learning, db, gate, retriever, attachRoutines: routineStore => learning.attachRoutines(routineStore) };
  } catch (error) {
    if (error.code === 'MEMORY_V2_STORAGE_CORRUPT') throw error;
    throw Object.assign(new Error(`The v2 memory engine could not start. Its storage was preserved. Set MERLIN_MEMORY_ENGINE=legacy and restart to roll back. Cause: ${error.message}`, { cause: error }), { code: error.code ?? 'MEMORY_V2_START_FAILED' });
  }
}
