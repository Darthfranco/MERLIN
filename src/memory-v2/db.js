import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const HOUSEHOLD = 'home';
export const VISIBILITY_SHARED = 'household';
const SCHEMA_VERSION = 1;

// Candidates are read only by background workers. Nothing live joins that table:
// search_items, its FTS index and item_vectors hold finalized material only.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exchanges (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
  user_source_id TEXT NOT NULL, assistant_source_id TEXT, outcomes TEXT NOT NULL DEFAULT '[]',
  segment_id TEXT, completed_at TEXT NOT NULL, captured_at TEXT, skip INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS exchanges_pending ON exchanges (session_id, seq) WHERE captured_at IS NULL;
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, opened_at TEXT NOT NULL,
  last_activity_ms INTEGER NOT NULL, close_requested INTEGER NOT NULL DEFAULT 0, close_reason TEXT, closed_at TEXT, boundary_seq INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, prepared TEXT);
CREATE INDEX IF NOT EXISTS segments_session ON segments (session_id, status);
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, exchange_seq INTEGER NOT NULL, source_ids TEXT NOT NULL,
  household TEXT NOT NULL, subject TEXT NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL, attribute TEXT NOT NULL DEFAULT '',
  conditions TEXT NOT NULL DEFAULT '', exceptions TEXT NOT NULL DEFAULT '', event_time TEXT NOT NULL DEFAULT '', temporal TEXT NOT NULL DEFAULT 'unknown',
  is_correction INTEGER NOT NULL DEFAULT 0, evidence_kind TEXT NOT NULL, payload TEXT, status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS candidates_pending ON candidates (exchange_seq, status);
CREATE TABLE IF NOT EXISTS control_items (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, request_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL,
  data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS control_session ON control_items (session_id, status);
CREATE TABLE IF NOT EXISTS records (
  id TEXT NOT NULL, version INTEGER NOT NULL, type TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'fact', household TEXT NOT NULL, subject TEXT NOT NULL,
  visibility TEXT NOT NULL, text TEXT NOT NULL, attribute TEXT NOT NULL DEFAULT '', conditions TEXT NOT NULL DEFAULT '', exceptions TEXT NOT NULL DEFAULT '',
  event_time TEXT NOT NULL DEFAULT '', effective_time TEXT NOT NULL DEFAULT '', temporal TEXT NOT NULL DEFAULT 'ongoing', evidence_kind TEXT NOT NULL,
  source_ids TEXT NOT NULL, source_quote TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, supersedes TEXT,
  profile INTEGER NOT NULL DEFAULT 0, provenance_gap INTEGER NOT NULL DEFAULT 0, operation_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (id, version));
CREATE UNIQUE INDEX IF NOT EXISTS records_operation ON records (operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS records_current ON records (status, subject, attribute);
CREATE TABLE IF NOT EXISTS search_items (
  key TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_id TEXT NOT NULL, ref_version INTEGER NOT NULL, household TEXT NOT NULL, subject TEXT NOT NULL,
  visibility TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, terms TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '{}',
  text_hash TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS search_items_ref ON search_items (kind, ref_id);
CREATE INDEX IF NOT EXISTS search_items_scope ON search_items (household, visibility, kind, subject, updated_at);
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(key UNINDEXED, title, text, terms, tokenize = 'porter unicode61');
CREATE TABLE IF NOT EXISTS item_vectors (
  key TEXT NOT NULL, model TEXT NOT NULL, text_hash TEXT NOT NULL, dimensions INTEGER NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (key, model));
CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entity_aliases (alias TEXT NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY (alias, entity_id));
CREATE TABLE IF NOT EXISTS item_entities (key TEXT NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY (key, entity_id));
CREATE INDEX IF NOT EXISTS item_entities_entity ON item_entities (entity_id);
CREATE TABLE IF NOT EXISTS documents_index (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS migration_map (legacy_collection TEXT NOT NULL, legacy_id TEXT NOT NULL, v2_id TEXT NOT NULL, PRIMARY KEY (legacy_collection, legacy_id));
CREATE TABLE IF NOT EXISTS tombstones (text_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL);
`;

export const sha = value => createHash('sha256').update(value).digest('hex');
export const normalizeKey = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
export const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };

/** Opens the private SQLite file, refusing to touch a corrupt one. */
export function openDatabase(filePath) {
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  let db;
  try {
    db = new DatabaseSync(filePath);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
    const integrity = db.prepare('PRAGMA quick_check').get();
    if (Object.values(integrity)[0] !== 'ok') throw new Error('integrity check failed');
    db.exec(SCHEMA);
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!version) db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    else if (Number(version.value) !== SCHEMA_VERSION) throw new Error(`unsupported schema version ${version.value}`);
  } catch (cause) {
    try { db?.close(); } catch { /* The original failure is what matters. */ }
    const error = new Error('The v2 memory database could not be opened; it was not overwritten. Preserve data/memory-v2 and set MERLIN_MEMORY_ENGINE=legacy to roll back.', { cause });
    error.code = 'MEMORY_V2_STORAGE_CORRUPT';
    throw error;
  }
  if (filePath !== ':memory:') for (const suffix of ['', '-wal', '-shm']) { try { chmodSync(filePath + suffix, 0o600); } catch { /* WAL files appear lazily. */ } }
  return db;
}

/** Runs a synchronous transaction. No await can occur inside, so no model or network work can either. */
export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the first failure. */ }
    throw error;
  }
}

export const getMeta = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
export const setMeta = (db, key, value) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));
export const deletionGeneration = db => Number(getMeta(db, 'deletion_generation') ?? 0);
export const bumpDeletionGeneration = db => setMeta(db, 'deletion_generation', deletionGeneration(db) + 1);

/** Replaces one searchable item, its FTS row, entity links and any stale vector in the caller's transaction. */
export function upsertSearchItem(db, item, entityIds = []) {
  const textHash = sha(`${item.title ?? ''}\n${item.text}\n${item.terms ?? ''}`);
  db.prepare('DELETE FROM search_fts WHERE key = ?').run(item.key);
  db.prepare(`INSERT INTO search_items (key, kind, ref_id, ref_version, household, subject, visibility, title, text, terms, location, text_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET kind = excluded.kind, ref_id = excluded.ref_id, ref_version = excluded.ref_version,
    household = excluded.household, subject = excluded.subject, visibility = excluded.visibility, title = excluded.title, text = excluded.text, terms = excluded.terms,
    location = excluded.location, text_hash = excluded.text_hash, updated_at = excluded.updated_at`)
    .run(item.key, item.kind, item.ref_id, item.ref_version, item.household ?? HOUSEHOLD, item.subject ?? 'household', item.visibility ?? VISIBILITY_SHARED,
      item.title ?? '', item.text, item.terms ?? '', JSON.stringify(item.location ?? {}), textHash, item.updated_at);
  db.prepare('INSERT INTO search_fts (key, title, text, terms) VALUES (?, ?, ?, ?)').run(item.key, item.title ?? '', item.text, item.terms ?? '');
  db.prepare('DELETE FROM item_vectors WHERE key = ? AND text_hash != ?').run(item.key, textHash);
  db.prepare('DELETE FROM item_entities WHERE key = ?').run(item.key);
  for (const entityId of new Set(entityIds)) db.prepare('INSERT OR IGNORE INTO item_entities (key, entity_id) VALUES (?, ?)').run(item.key, entityId);
  return textHash;
}

export function removeSearchItem(db, key) {
  db.prepare('DELETE FROM search_fts WHERE key = ?').run(key);
  db.prepare('DELETE FROM search_items WHERE key = ?').run(key);
  db.prepare('DELETE FROM item_vectors WHERE key = ?').run(key);
  db.prepare('DELETE FROM item_entities WHERE key = ?').run(key);
}

/** Stable entity lookup by exact name. A new name creates one entity, never a merge with a similar one. */
export function ensureEntity(db, { name, type = 'unknown', aliases = [] }) {
  const clean = String(name ?? '').trim();
  const norm = normalizeKey(clean);
  if (!norm) return null;
  const id = `entity:${sha(`${type}:${norm}`).slice(0, 24)}`;
  db.prepare('INSERT OR IGNORE INTO entities (id, type, name) VALUES (?, ?, ?)').run(id, type, clean);
  // A person or room starts with at most five observed aliases.
  for (const alias of [clean, ...aliases].slice(0, 5)) {
    const value = normalizeKey(alias);
    if (value) db.prepare('INSERT OR IGNORE INTO entity_aliases (alias, entity_id) VALUES (?, ?)').run(value, id);
  }
  return id;
}

export const recordKey = (id, version) => `record:${id}:${version}`;
export const toRecord = row => row && ({ ...row, source_ids: parse(row.source_ids, []), profile: Boolean(row.profile), provenance_gap: Boolean(row.provenance_gap) });
