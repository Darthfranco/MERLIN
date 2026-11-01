import { HOUSEHOLD, VISIBILITY_SHARED, normalizeKey, parse, recordKey, removeSearchItem, sha, toRecord, upsertSearchItem } from './db.js';

export const SEARCHABLE_STATUS = new Set(['current', 'unresolved']);
export const textHash = text => sha(normalizeKey(text));

function indexRecord(db, record, entityIds) {
  upsertSearchItem(db, {
    key: recordKey(record.id, record.version), kind: 'record', ref_id: record.id, ref_version: record.version,
    household: record.household, subject: record.subject, visibility: record.visibility, title: '', text: record.text,
    terms: [record.subject === 'household' ? '' : record.subject, record.attribute, record.conditions].filter(Boolean).join(' '),
    location: { type: record.type, memory_kind: record.kind, attribute: record.attribute, conditions: record.conditions, exceptions: record.exceptions, temporal: record.temporal,
      event_time: record.event_time, effective_time: record.effective_time, evidence_kind: record.evidence_kind, status: record.status, source_ids: record.source_ids, provenance_gap: record.provenance_gap },
    updated_at: record.updated_at,
  }, entityIds);
}

/** Inserts one immutable record version in the caller's transaction and indexes it when searchable. */
export function writeRecordVersion(db, value, entityIds = []) {
  const record = {
    household: HOUSEHOLD, visibility: VISIBILITY_SHARED, kind: 'fact', attribute: '', conditions: '', exceptions: '', event_time: '', effective_time: '', temporal: 'ongoing',
    source_quote: '', reason: '', supersedes: null, profile: false, provenance_gap: false, operation_id: null, updated_at: value.created_at, ...value,
  };
  db.prepare(`INSERT INTO records (id, version, type, kind, household, subject, visibility, text, attribute, conditions, exceptions, event_time, effective_time, temporal, evidence_kind,
    source_ids, source_quote, reason, status, supersedes, profile, provenance_gap, operation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(record.id, record.version, record.type, record.kind, record.household, record.subject, record.visibility, record.text, record.attribute, record.conditions, record.exceptions,
      record.event_time, record.effective_time, record.temporal, record.evidence_kind, JSON.stringify(record.source_ids), record.source_quote, record.reason, record.status, record.supersedes,
      record.profile ? 1 : 0, record.provenance_gap ? 1 : 0, record.operation_id, record.created_at, record.updated_at);
  if (SEARCHABLE_STATUS.has(record.status)) indexRecord(db, record, entityIds);
  return record;
}

export const currentVersion = (db, id) => toRecord(db.prepare(`SELECT * FROM records WHERE id = ? AND status IN ('current', 'unresolved') ORDER BY version DESC LIMIT 1`).get(id));
export const latestVersion = (db, id) => toRecord(db.prepare('SELECT * FROM records WHERE id = ? ORDER BY version DESC LIMIT 1').get(id));
export const allVersions = (db, id) => db.prepare('SELECT * FROM records WHERE id = ? ORDER BY version').all(id).map(toRecord);

/** Prior versions stay as history but leave the search index in the same transaction as their replacement. */
export function retireVersion(db, id, version, now) {
  db.prepare(`UPDATE records SET status = 'superseded', updated_at = ? WHERE id = ? AND version = ?`).run(now, id, version);
  removeSearchItem(db, recordKey(id, version));
}

/** Every version linked through any supersession, including imported legacy chains under separate IDs. */
export function chainIds(db, id) {
  const ids = new Set([id]);
  const rows = db.prepare('SELECT id, supersedes FROM records WHERE supersedes IS NOT NULL').all();
  let changed = true;
  while (changed) {
    changed = false;
    for (const { id: current, supersedes } of rows) {
      const target = String(supersedes).split(':v')[0];
      if (ids.has(current) !== ids.has(target)) { ids.add(current); ids.add(target); changed = true; }
    }
  }
  return [...ids];
}

/** Hard-removes a record's versions, index rows and any draft on the same point. Records a tombstone so late work cannot restore it. */
export function forgetChain(db, id, now) {
  const ids = chainIds(db, id);
  const sourceIds = new Set();
  const topics = new Set();
  for (const chainId of ids) {
    for (const version of allVersions(db, chainId)) {
      version.source_ids.forEach(source => sourceIds.add(source));
      db.prepare('INSERT OR REPLACE INTO tombstones (text_hash, created_at) VALUES (?, ?)').run(textHash(version.text), now);
      removeSearchItem(db, recordKey(version.id, version.version));
      if (version.attribute) topics.add(`${normalizeKey(version.subject)}\n${normalizeKey(version.attribute)}`);
    }
    db.prepare('DELETE FROM records WHERE id = ?').run(chainId);
  }
  const drafts = db.prepare(`SELECT id, subject, attribute, source_ids FROM candidates WHERE status != 'processed'`).all();
  for (const draft of drafts) {
    const cited = parse(draft.source_ids, []).some(source => sourceIds.has(source));
    if (cited || topics.has(`${normalizeKey(draft.subject)}\n${normalizeKey(draft.attribute)}`)) db.prepare('DELETE FROM candidates WHERE id = ?').run(draft.id);
  }
  // A name that now links to nothing is forgotten with its last record.
  db.prepare('DELETE FROM entity_aliases WHERE entity_id NOT IN (SELECT entity_id FROM item_entities)').run();
  db.prepare('DELETE FROM entities WHERE id NOT IN (SELECT entity_id FROM item_entities)').run();
  return { ids, source_ids: [...sourceIds].filter(source => source !== 'manual') };
}
