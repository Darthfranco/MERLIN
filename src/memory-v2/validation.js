import { normalizeKey } from './db.js';

// Model output is only ever a proposal. These checks decide what may enter a draft or a record.
export const EVIDENCE_KINDS = ['direct', 'verified_result', 'assistant_suggestion', 'external', 'inference'];
export const MAX_CANDIDATES_PER_EXCHANGE = 6;
const OPERATIONS = ['create', 'supersede', 'merge', 'unresolved', 'discard'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, maximum) => typeof value === 'string' && value.length <= maximum;
const nonEmpty = (value, maximum) => text(value, maximum) && Boolean(value.trim());
const sameTopic = (a, b) => normalizeKey(a.subject) === normalizeKey(b.subject) && normalizeKey(a.attribute) === normalizeKey(b.attribute) && normalizeKey(a.conditions) === normalizeKey(b.conditions);

/** Enforces source grounding on the extractor. Throwing here keeps the exchange queued for a bounded retry. */
export function validateCandidates(raw, { userMessages, sourceIds, hasCompletedOutcome }) {
  if (!object(raw) || !Array.isArray(raw.candidates) || raw.candidates.length > MAX_CANDIDATES_PER_EXCHANGE) throw new Error('Unexpected candidate extraction response.');
  return raw.candidates.map(item => {
    if (!object(item) || !['semantic', 'episodic'].includes(item.type) || !nonEmpty(item.text, 2000) || !nonEmpty(item.subject, 120)
      || !EVIDENCE_KINDS.includes(item.evidence_kind) || !['ongoing', 'temporary', 'unknown'].includes(item.temporal) || typeof item.is_correction !== 'boolean'
      || !Array.isArray(item.source_ids) || !item.source_ids.length || item.source_ids.length > 8 || !item.source_ids.every(id => sourceIds.has(id))
      || !['attribute', 'conditions', 'exceptions', 'event_time', 'source_quote'].every(key => text(item[key], 2000))) throw new Error('Invalid extracted candidate.');
    if (item.evidence_kind === 'direct') {
      const cited = item.source_ids.filter(id => userMessages.has(id)).map(id => userMessages.get(id));
      if (!item.source_quote.trim() || !cited.some(message => message.includes(item.source_quote))) throw new Error('A direct candidate needs an exact user quotation.');
    }
    if (item.evidence_kind === 'verified_result' && (!hasCompletedOutcome || item.type !== 'episodic')) throw new Error('A verified result needs a completed tool outcome and describes an event.');
    if (item.is_correction && item.evidence_kind !== 'direct') throw new Error('Only a direct user statement can be a correction.');
    return item;
  });
}

function evidenceOf(candidates) {
  const kinds = new Set(candidates.map(item => item.evidence_kind));
  return kinds.has('direct') ? 'direct' : kinds.has('verified_result') ? 'verified_result' : kinds.has('inference') ? 'inference' : null;
}

function validateOperation(op, used, { candidates, records }) {
  if (!object(op) || !OPERATIONS.includes(op.op) || !Array.isArray(op.candidate_ids) || !op.candidate_ids.length) return 'Malformed operation.';
  const cited = [];
  for (const id of op.candidate_ids) {
    if (!candidates.has(id)) return 'Cites a candidate outside this batch.';
    if (used.has(id)) return 'Candidate was already consumed by another operation.';
    cited.push(candidates.get(id));
  }
  if (op.op === 'discard') return { op: 'discard', candidate_ids: op.candidate_ids, reason: String(op.reason ?? '').slice(0, 500) };
  if (!['semantic', 'episodic'].includes(op.type) || !nonEmpty(op.text, 2000) || !nonEmpty(op.subject, 120)
    || !['attribute', 'conditions', 'exceptions', 'event_time', 'effective_time', 'reason'].every(key => text(op[key] ?? '', 2000))) return 'Malformed record fields.';
  const evidence = evidenceOf(cited);
  // Assistant suggestions and external passages can only be discarded, never published.
  if (!evidence) return 'Only suggestion or external evidence; it cannot publish a record.';
  const allowedSources = new Set(cited.flatMap(item => item.source_ids));
  const sourceIds = Array.isArray(op.source_ids) && op.source_ids.length ? op.source_ids : [...allowedSources];
  if (!sourceIds.every(id => allowedSources.has(id))) return 'Cites a source outside its candidates.';
  const temporary = op.temporal === 'temporary' || cited.some(item => item.temporal === 'temporary');
  let type = op.type;
  let operation = op.op;
  // A completed action alone does not prove a preference; a one-off stays an event.
  if (evidence === 'verified_result' && type === 'semantic') return 'A verified action alone cannot establish a semantic preference.';
  if (temporary) type = 'episodic';
  if (evidence === 'inference' && type === 'semantic' && operation === 'create') operation = 'unresolved';
  const fields = {
    op: operation, type, text: op.text.trim(), subject: op.subject.trim(), attribute: (op.attribute ?? '').trim(), conditions: (op.conditions ?? '').trim(), exceptions: (op.exceptions ?? '').trim(),
    event_time: (op.event_time ?? '').trim(), effective_time: (op.effective_time ?? '').trim(), temporal: temporary ? 'temporary' : 'ongoing', evidence_kind: evidence,
    candidate_ids: op.candidate_ids, source_ids: sourceIds, source_quote: cited.find(item => item.source_quote)?.source_quote ?? '', target_id: '', expected_version: 0,
    entities: Array.isArray(op.entities) ? op.entities.filter(entity => object(entity) && nonEmpty(entity.name, 120)).slice(0, 5)
      .map(entity => ({ name: entity.name.trim(), type: nonEmpty(entity.type, 40) ? entity.type : 'unknown', aliases: Array.isArray(entity.aliases) ? entity.aliases.filter(alias => nonEmpty(alias, 120)).slice(0, 4) : [] })) : [],
    profile: op.profile === true && evidence === 'direct' && !temporary && type === 'semantic', reason: (op.reason ?? '').slice(0, 500),
    // Always-read guidance needs the user's own words; an inference cannot become an instruction.
    memory_kind: type === 'semantic' && ['fact', 'preference', 'guidance'].includes(op.memory_kind) && (op.memory_kind !== 'guidance' || evidence === 'direct') ? op.memory_kind : null,
  };
  if (['supersede', 'merge'].includes(operation)) {
    const target = records.get(op.target_id);
    if (!target) return 'Target record was not offered for this batch.';
    if (!Number.isSafeInteger(op.expected_version) || op.expected_version < 1) return 'Target needs its expected version.';
    fields.target_id = target.id; fields.expected_version = op.expected_version;
    if (operation === 'supersede') {
      if (temporary) return 'A temporary change cannot replace an ongoing record.';
      if (target.type !== 'semantic' || type !== 'semantic') return 'Only semantic records can be superseded.';
      if (!cited.some(item => item.evidence_kind === 'direct' && item.is_correction && item.temporal === 'ongoing')) return 'Replacing a record needs a direct explicit ongoing correction.';
      if (!sameTopic(target, fields)) return 'A correction must match the subject, attribute and conditions it replaces.';
    } else {
      if (target.type !== type) return 'A merge must keep the record type.';
      if (type === 'episodic' && normalizeKey(target.event_time) !== normalizeKey(fields.event_time)) return 'Separate events stay separate.';
      if (type === 'semantic' && !sameTopic(target, fields)) return 'A merge must keep subject, attribute and conditions.';
    }
  }
  if (operation === 'create' && type === 'semantic' && fields.attribute) {
    const clash = [...records.values()].find(record => record.status === 'current' && record.type === 'semantic' && sameTopic(record, fields));
    if (clash) {
      // A duplicate merges; a different value without an explicit correction stays unresolved.
      if (normalizeKey(clash.text) === normalizeKey(fields.text)) { fields.op = 'merge'; fields.target_id = clash.id; fields.expected_version = clash.version; }
      else fields.op = 'unresolved';
    }
  }
  return fields;
}

/** Deterministically accepts or rejects each proposed operation. Rejected candidates stay queued. */
export function validateProposal(raw, { candidates, records, sourceIds }) {
  if (!object(raw) || !Array.isArray(raw.operations) || raw.operations.length > 64) throw new Error('Unexpected consolidation response.');
  const used = new Set();
  const operations = [];
  const rejected = [];
  for (const op of raw.operations) {
    const result = validateOperation(op, used, { candidates, records });
    if (typeof result === 'string') { rejected.push({ reason: result, candidate_ids: Array.isArray(op?.candidate_ids) ? op.candidate_ids.filter(id => candidates.has(id) && !used.has(id)) : [] }); continue; }
    result.candidate_ids.forEach(id => used.add(id));
    operations.push(result);
  }
  const summary = object(raw.summary) && nonEmpty(raw.summary.text, 2000) && Array.isArray(raw.summary.source_ids) && raw.summary.source_ids.length && raw.summary.source_ids.every(id => sourceIds.has(id))
    ? { text: raw.summary.text.trim(), source_ids: raw.summary.source_ids } : null;
  return { operations, rejected, summary };
}
