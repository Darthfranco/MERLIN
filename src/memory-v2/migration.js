import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryStore } from '../memory-store.js';
import { ensureEntity, getMeta, normalizeKey, setMeta, transaction } from './db.js';
import { legacyPath, v2Dir, writeAtomic } from './fence.js';
import { writeRecordVersion } from './records.js';

const CORE_COMMUNICATION = /answer|respond|response|communication|concise|brief|verbosity/iu;

async function backupLegacy(dataDir, state, contents, cutoff) {
  const directory = join(v2Dir(dataDir), 'backup');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, 'memory.json');
  await copyFile(legacyPath(dataDir), target);
  await chmod(target, 0o600);
  const manifest = {
    created_at: new Date().toISOString(), rollback_cutoff: cutoff,
    files: [{ name: 'memory.json', bytes: (await stat(target)).size, sha256: createHash('sha256').update(contents).digest('hex') }],
    counts: { facts: state.facts.length, rules: state.rules.length, documents: state.documents.length, conversations: state.conversations.length },
    note: 'Private rollback copy. Owner deletions and Delete all memory are applied to it too. The legacy queue file stays in place and holds source IDs only.',
  };
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

/** One-time, restart-safe import into separate storage. The legacy file is only ever read here. */
export async function migrateLegacy({ dataDir, db, sourcesPath }) {
  if (getMeta(db, 'migration_complete')) return { migrated: false };
  const cutoff = new Date().toISOString();
  let contents = null;
  try { contents = await readFile(legacyPath(dataDir), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let state = { version: 1, revision: 0, epoch: 0, facts: [], rules: [], documents: [], conversations: [], events: [] };
  if (contents !== null) {
    // Validate through the real store before copying anything.
    const checked = await new MemoryStore({ filePath: legacyPath(dataDir) }).init();
    const { revision, epoch, personality, facts, rules, documents, conversations } = checked.snapshot();
    state = { version: 1, revision, epoch, personality, facts, rules, documents, conversations, events: [] };
    await backupLegacy(dataDir, state, contents, cutoff);
  }
  // Rewritten until the marker commits, so an interrupted import simply starts over.
  await writeAtomic(sourcesPath, `${JSON.stringify({ ...state, facts: [] }, null, 2)}\n`);
  const sourceIds = new Set(state.conversations.map(item => item.id));
  const counts = transaction(db, () => {
    const map = db.prepare('INSERT OR IGNORE INTO migration_map (legacy_collection, legacy_id, v2_id) VALUES (?, ?, ?)');
    for (const fact of state.facts) {
      const manual = fact.source_id === 'manual';
      const entity = normalizeKey(fact.subject) === 'household' ? [] : [ensureEntity(db, { name: fact.subject, type: 'person' })];
      db.prepare('DELETE FROM records WHERE id = ?').run(fact.id);
      writeRecordVersion(db, { id: fact.id, version: 1, type: 'semantic', kind: fact.kind, subject: fact.subject, text: fact.content, evidence_kind: manual ? 'manual' : 'direct',
        source_ids: [fact.source_id], source_quote: fact.source_quote, reason: fact.reason, status: fact.status === 'active' ? 'current' : 'superseded', supersedes: fact.supersedes ? `${fact.supersedes}:v1` : null,
        profile: fact.status === 'active' && CORE_COMMUNICATION.test(fact.content), provenance_gap: !manual && !sourceIds.has(fact.source_id), created_at: fact.created_at, updated_at: fact.updated_at }, entity);
      map.run('facts', fact.id, fact.id);
    }
    for (const rule of state.rules) map.run('rules', rule.id, rule.id);
    for (const document of state.documents) map.run('documents', document.id, document.id);
    setMeta(db, 'rollback_cutoff', cutoff);
    setMeta(db, 'migration_complete', JSON.stringify({ at: cutoff, facts: state.facts.length, rules: state.rules.length, documents: state.documents.length, conversations: state.conversations.length, legacy_present: contents !== null }));
    return { facts: state.facts.length, rules: state.rules.length, documents: state.documents.length };
  });
  return { migrated: true, ...counts };
}
