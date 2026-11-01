# MERLIN memory engine v2

This is the owner's *Home Agent Memory Procedure* (version 1, October 28, 2026), implemented as a selectable engine beside the existing one. The procedure is the behavioral source of truth for v2. [MEMORY.md](MEMORY.md) describes the legacy engine, which stays available as the rollback. Status and check results are in [STATUS.md](STATUS.md).

**Legacy is still the default.** The owner's condition for making v2 the default is that its real semantic adapter is usable. As of November 1, 2026 that holds on the development Mac, where Ollama and `nomic-embed-text` are installed and checked. Switching remains the owner's decision, so v2 is still an explicit opt-in. A machine with no embedding service runs v2 with semantic retrieval reported as degraded, and lexical, entity, and lifecycle behavior still work.

## Enable, check, roll back

```bash
# See whether the embedding service is ready. Synthetic text only; no Meta calls.
npm run check:memory-v2

# Also make two small paid Meta calls to confirm the v2 contracts are accepted. Synthetic text only.
npm run check:memory-v2 -- --meta

# Run v2.
MERLIN_MEMORY_ENGINE=v2 npm start

# Roll back: one setting and a restart.
MERLIN_MEMORY_ENGINE=legacy npm start
```

To enable semantic retrieval on a Mac:

```bash
brew install ollama
brew services start ollama
ollama pull nomic-embed-text
npm run check:memory-v2
```

The service starts again at login and listens only on `127.0.0.1:11434`. To stop it, run `brew services stop ollama`. Any service with the same `POST /api/embed` and `GET /api/tags` endpoints works through `MERLIN_EMBEDDING_URL` and `MERLIN_EMBEDDING_MODEL`. `.env.example` lists the settings. A different model needs its own cutoff from `npm run calibrate:memory-v2`. To make v2 the default, change `DEFAULT_MEMORY_ENGINE` in `src/memory-engine.js`.

What rollback does and does not do:

- Only the selected engine's worker runs. Nothing is dual-written and retrieval outputs are never merged.
- `data/memory.json` is unchanged by normal v2 learning, so legacy resumes from its state at the **rollback cutoff**, shown in the inspector. **Learning that happened under v2 does not carry over to legacy.** Corrections made under legacy do not flow back into v2.
- v2 data stays intact in `data/memory-v2/` and is there when you switch back.
- Deletions do cross over. See [Forgetting](#forgetting).

If v2 fails to start, its storage is preserved and the error names the rollback setting. A v2 error is never silently answered by legacy on a per-request basis: the last committed v2 state stays in use and the degraded capability is reported.

## The three timescales

| Timescale | Where it lives | Who reads it |
| --- | --- | --- |
| **Current conversation** | Replay history plus a small per-session control state (`control_items`) | The main model, and the rule/action/output checks, immediately |
| **Draft notes** | `candidates` table, written after each completed exchange | Only the background capture and consolidation workers. Never live search, embeddings, or the main prompt |
| **Finalized memory** | `records`, indexed in `search_items` | Live retrieval, for every conversation, after publication |

**Control state** is not a second draft store and is not searchable. It holds checked `memory_save_rule` and `memory_save_fact` calls, plus exact quotes of direct user wording such as "actually" or "tonight." No value is parsed out of those quotes. They carry a correction or temporary scope forward once ordinary history stops replaying it. Control rules merge into `rules()` for that session only, so every existing action and output check applies in the same request. Outside any chat, such as the manual timer form or speech, the check covers all open conversations, which errs toward the restriction.

## Live path

The reply path awaits one thing beyond the normal main model: query embedding plus search and source reads. It never waits for extraction, consolidation, document indexing, or stored-text embeddings.

1. Record the user message, a small durable write, and start the foreground clock.
2. `prepareContext` runs fixed retrieval. There is no foreground memory agent and no reranker.
3. The main model answers using soul and rules, conversation, control state, and selected evidence.
4. Record the reply, enqueue the exchange durably with sanitized verified outcomes, and return.

Retrieval prepares the query from the request and a little recent context, applies scope inside each branch's SQL, runs four branches concurrently, and merges by stable ID and version with reciprocal rank fusion, `sum(1 / (60 + rank))`, equal weights.

| Branch | Starting cap |
| --- | --- |
| Semantic: real embeddings, same model and version for query and records | 40 |
| Keyword: FTS5 BM25 | 30 |
| Entity: exact aliases, by matched entity count then update time | 20 |
| Recent: finalized records for a subject actually named in the request or recent turns | 10 |

Selection starts at 12 items and 4,000 estimated tokens. **Token figures are a conservative estimate of about three characters per token, not a tokenizer count.** Always-read rules, guidance, and the profile are separate and are never truncated to fit. An empty or irrelevant result stays empty, including no "recent" filler when no subject was named. An alias naming several entities is reported as `ambiguous_names` and both remain candidates. A query is embedded once per request; it is only recomputed if the query changes, such as routine expansion.

The search index covers finalized records, routine cards, document discovery cards, and original document passages. Original messages stay available only through the explicit `memory_read_sources` tool.

## Capture, close, and consolidation

- **Capture** serializes in sequence order and sends the exchange plus bounded recent messages to `extractCandidates`. Finalized memories are not resent. Output is strictly validated: direct evidence needs an exact user quotation, and verified results need a completed outcome. The checkpoint advances only after the append. A retry finds the existing append and does not call the model again. Unprocessed work and sources are retained on failure. The save-to-enqueue crash gap is reconciled at startup, without reinterpreting the imported archive.
- **Close** happens on `POST /api/session/close` or 120 seconds without foreground activity. Background work never resets that timer, and a segment never closes mid-request. Voice standby and wake follow-up are separate clocks and are unchanged. There are no goodbye or thanks endings. Closing freezes `boundary_seq`; a resumed chat uses a later segment and keeps its conversation context.
- **Consolidation** waits until capture has covered the boundary, then proposes operations in bounded batches of 20 candidates with related finalized records and sources. Code validates every operation against allowed IDs, scope, type, evidence, and expected version. The proposal is persisted before any write, so a storage retry does not repeat a successful model call.
- **Publication** prepares embeddings first, outside any transaction, then commits records, retires prior versions, and updates the index in one transaction. Candidates are acknowledged afterward by exact ID. A moved target version sends the proposal back to reconcile from current state; there is no last-writer-wins. If embedding is down, the record publishes with lexical search and its vector is queued.
- **Retries** run one job at a time, yield to foreground requests, and back off for at most five attempts before showing a retry control. An outage cannot become a costly loop.

| Evidence or situation | Result |
| --- | --- |
| Direct, explicit, ongoing correction of the same subject, attribute, and conditions | New version becomes current; prior version stays as superseded history with its sources |
| Temporary request ("tonight") | Stays a dated event and cannot supersede anything |
| Different value on the same point without an explicit correction | Published as `unresolved`, never as a second certain fact |
| Different conditions, or different people | Coexist as separate records |
| Identical wording, separate occasions | Stay separate events |
| Inference | `unresolved`; cannot become guidance or profile |
| Assistant suggestion or external passage | Can only be discarded |
| Completed action alone | An event only, never a preference |

Explicit rules publish through code with `store.putRule`, idempotent by candidate ID, and never through the model. Conflicting rules still both publish and stay flagged. Publication does not change `store.epoch`, so it never triggers deletion cleanup or disturbs other conversations' pending drafts.

## Routines and documents

Routines still save immediately through the existing routine system, because they are operational state. Cards are indexed for search at the next retrieval and vectors follow in the background. A card carries no authorization, and existing activation, confirmation, and rule checks are unchanged. Consolidation can record an episode about a routine but never saves or runs one.

The existing `.txt`/`.md` importer is extended, not replaced. A background job indexes exact source slices with document ID, version, section heading, character offsets, and table headers, plus a compact discovery card. A passage also carries a nearby qualification from its section. Index status is `pending`, `failed`, or `ready`; while not ready, the model is told exact reads work now. Replacing a document stops old text being retrievable immediately. PDF, OCR, Word, and AI-generated outlines are out of scope.

## Storage and migration

Everything is ignored runtime data under `data/memory-v2/`:

| File | Contents |
| --- | --- |
| `memory.sqlite` | Records, FTS5 index, vectors, candidates, exchanges, segments, control state, entities, migration map |
| `sources.json` | A `MemoryStore` holding transcripts, rules, documents, and personality, so existing evidence checks and interfaces keep working |
| `backup/` | Owner-only pre-migration copy of `memory.json`, with a manifest of hashes, counts, and the cutoff |
| `fence.json` | The durable deletion fence |

Migration runs once, behind a marker committed with the imported records, and restarts cleanly if interrupted. Legacy IDs carry over unchanged. Superseded legacy facts stay as history. Evidence legacy had already removed is labeled `provenance_gap`; it cannot be reconstructed. Legacy facts have no structured attribute, so an old fact cannot be automatically superseded until a new record states one. Routines stay in the shared `data/routines.json`, and the historical archive is not reinterpreted.

## Forgetting

The existing owner controls keep working, and this does not add a new deletion workflow. A durable fence entry is written first, then applied to the active engine, its pending jobs, drafts, index entries and vectors, and to **both rollback copies: `data/memory.json` and `data/memory-v2/backup/memory.json`**. Each engine reapplies unfinished entries at startup, so a crash between steps finishes later.

- In-flight jobs compare a deletion generation before writing, so a late model result is discarded and re-derived from what survives. A tombstone blocks publication of forgotten text unless a later user statement says it again.
- Forgetting a record removes its whole version chain, its cited source messages, drafts citing those sources or on the same subject and attribute, and any entity name left unreferenced.
- Deletions under legacy reach the backup immediately and v2 at its next start. **Delete all memory** clears every layer and removes the backup.
- This covers local application records only. It does not cover independent backups, screenshots, or data already handled under the provider's terms.

## Inspecting

`GET /api/memory` adds `memory_engine`, `engine` (selected engine, cutoff, migration counts, cutoff value and calibration status, limits), and in `learning`: capture backlog, candidate counts, open segments, consolidating segments with their boundaries, semantic readiness, index counts, document status, and retry availability. These status fields carry no household content. Memory lab shows version, type, evidence kind, temporary or unresolved status, and provenance gaps on each record, with no UI redesign. **Behind this response** adds per-branch counts, semantic state, and estimated tokens.

## Semantic calibration

`npm run calibrate:memory-v2` runs a labeled set from `scripts/memory-v2-calibration-set.js` through the configured model and the real search path, on a throwaway database with no Meta calls. The set has 39 records, 450 plausible distractors, 39 answerable queries worded to avoid the record's words, and 26 unanswerable queries. It picks the highest cutoff that gives up at most one query from the best recall on one half of the set, then reports the other half.

Results for `nomic-embed-text` on November 1, 2026. The full-search rows use all queries, including the half that chose the cutoff, and up to 12 items per query:

| Search | Answer retrieved | Items per general question | Items per household-sounding question |
| --- | --- | --- | --- |
| Keyword and entity only | 5 of 39 | 0.4 | 2.1 |
| Hybrid at the earlier 0.45 | 34 of 39 | 4.2 | 10.9 |
| Hybrid at the chosen 0.525 | 33 of 39 | 0.4 | 6.6 |

On the held-out half alone, the semantic branch at 0.525 found 84 percent of answers. No general question returned a semantic result, and 57 percent of household-sounding questions returned at least one false match.

How to read this:

- **The keyword gap is exaggerated on purpose,** because the queries avoid the record's words. It shows what semantic search adds, not how often real questions need it.
- **No cutoff separates near misses.** "Is the pool heater on?" scores close to a record about the space heater, and "What color should we paint the guest room?" scores 0.74 against distractors that name that room. Those items reach the model as context, and it has to judge them.
- **The store is small and invented,** so real recall could be lower.
- **Task prefixes are not used.** The model's documented `search_query:` and `search_document:` prefixes made no clear difference on the 39 records: top-1 recall 87 versus 90 percent without them, top-12 recall 100 versus 97 percent, each about one query. The adapter stays simple. Adding them later needs a new model identity, so stored vectors are rebuilt.

Query embedding took about 17 ms with the model loaded and about 300 ms after Ollama unloaded it, which it does after five idle minutes. Both are well under the 1,500 ms query timeout. A slower first load, such as just after a reboot, was not measured; a timeout falls back to lexical search for that request.

## Local choices and limits

These are implementation choices, not owner decisions: SQLite through built-in `node:sqlite` with FTS5, a bounded vector scan, `sources.json` as the source log, the Ollama development adapter with `nomic-embed-text`, and the cutoff of 0.525.

- **Semantic recall has only been measured on invented text.** See [Semantic calibration](#semantic-calibration). Automated tests still use an injected deterministic embedder, which proves ordering, reuse, and fallbacks, not recall.
- **The cosine cutoff is calibrated for one model on a synthetic set**, and the inspector reports `synthetic_set` for that model and `none` for any other model or an overridden value. It has not been checked against real household queries.
- **Live Meta coverage is two synthetic conversations.** `npm run check:memory-v2 -- --meta` and two end-to-end conversations succeeded on November 1, 2026, the second with real embeddings. That shows the provider accepts the v2 tools and schemas; it does not measure extraction or consolidation quality. Wording is model-dependent: the first run replied "I'll remember." After the instruction was tightened, the second replied "I'll use the red sofa," but no code check enforces this wording.
- **Vector search is a full scan**, with no ANN index. Measured locally with embedding excluded: p50 about 12 ms and p95 about 17 ms for 2,000 items at 768 dimensions over 200 queries. That is one machine and a synthetic corpus, not a scale or recall claim.
- `node:sqlite` is verified on the running Node 26.5 only. The project minimum is 22.16, where it may print an experimental warning. Legacy does not load it.
- Temporary control items stay in a session with their timestamps rather than parsed expiry times; the model judges elapsed time from the stated time.
- One shared household, with no speaker recognition or new login. `private:<subject>` visibility is enforced by retrieval, but nothing assigns it yet.
