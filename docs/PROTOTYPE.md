# MERLIN text prototype

This is the local application slice requested by the owner on October 26, 2026: **typed request → Meta chooses a tool → execution → text reply**. It implements web search, multiple labeled countdown timers, and the subsequently requested [memory system and keyword routines](MEMORY.md). It does not replace the full product scope or select the final app platform.

## Run locally

Requires **Node.js 22.16+**. No third-party runtime or test packages are required.

```sh
cp .env.example .env
# Edit .env and set META_API_KEY locally. Never paste or commit the key.
npm run check:meta
npm start
```

If `.env` already exists, edit it rather than overwriting it. Open [the local UI](http://127.0.0.1:3000). `npm run dev` watches server files. Refresh the browser after changing UI files. Stop with Ctrl+C before starting another process. The server binds to loopback only; it is not a remotely accessible or authenticated household service.

Without a key, the UI explains setup and offers **Test a timer directly**, clearly bypassing Meta. There is no fallback model or fake AI mode. `npm run check:meta` checks the actual authenticated model list without printing credentials. `META_MODEL` defaults to standard `muse-spark-1.3`; Contributor variants and unrelated providers are rejected. `MODEL_API_KEY` is accepted as a server-side compatibility alias. The adapter endpoint is fixed to `https://api.meta.ai/v1`.

Try:

- “Set a 30-second tea timer.”
- “Set a 2-minute pasta timer.”
- “What timers are running?”
- “Cancel the pasta timer.”
- “Search the web for how to descale a kettle.”
- “Set a 3-minute tea timer and a 10-minute pasta timer, then search for how to descale a kettle and clean a coffee grinder.”

One message can include multiple searches, multiple timers, or both together. The model can return a batch of timer calls, and MERLIN executes each validated call and returns all results before the next model round. Individual tool failures are reported alongside successful results.

Timers show running, finished, and cancelled states with local-time deadlines and an explicit time zone. Cancel and Dismiss buttons work directly; dismissal hides a finished/cancelled timer. Keep the server running and page open for visible completion. There is no alarm sound, background browser notification, wake lock, or delivery while the machine sleeps. Overdue timers reconcile when the server resumes/restarts.

## Execution and boundaries

- `src/meta.js` calls the **Meta Responses API**. Built-in `web_search` executes inside Meta; custom timer functions execute locally. Search events are reported from actual `web_search_call` output, and returned URL citations become safe clickable source links. A failed search or missing citation is not fabricated into a success or source.
- `src/assistant.js` advertises `create_timer`, `list_timers`, and `cancel_timer`, validates arguments, and returns real results to Meta. Parallel function-call generation is enabled; local timer operations are still applied in order to preserve dependencies. `src/limits.js` caps a user request at eight model rounds, 64 local calls, and 12 built-in search calls across all rounds. The remaining search budget is passed to Meta each round; at zero, web search is omitted while timer tools remain available. Only complete responses/function calls execute. Unknown tools fail closed. Partial success stays visible if the final model response fails. The browser uses the server's timeout allowance for compound requests instead of stopping after two minutes.
- The owner explicitly requested mixed search/timer actions in one ask. The original blanket prohibition on timer changes after retrieval has been removed. The model is instructed to treat pages/tool output as data, use retrieved facts only for user-requested tasks, and never treat page instructions as permission for additional actions. Validation, scoped tools, and retry protection remain in place. These prompt instructions are not a general adversarial-content authorization system; the future household permission system remains unimplemented.
- `src/timers.js` uses absolute UTC deadlines with explicit named time zones, atomic file replacement, serialized writes, and stable operation IDs. One-time duration timers accept 1–604800 seconds and labels of 1–80 characters, with at most 50 running timers. Clock-time alarms and recurring schedules are not implemented. Timer completion uses ordinary server scheduling, with no model call.
- `src/requests.js` records a hash-only receipt before a request can run. Concurrent retries with the same request ID share one result. Reusing an ID with different input fails. After restart/cache expiry, an already attempted ID is refused rather than re-executed; inspect timers before submitting a new request. Received errors show known tool results; uncertain browser disconnects keep the ID for an explicit retry. No automatic model retries occur.
- `src/server.js` permits only loopback hosts, checks Origin, requires JSON for mutations, limits request size, and serves an explicit UI-file whitelist. The runtime lock prevents a second normal server from writing the same data files. This is a single-process prototype; do not share `data/` between runtimes.
- The **Memory lab** shows exact conversation records, household facts/guidance, compiled do/don't rules, named documents, routines, and learning activity. **Behind this response** shows selections, rule checks, tool outcomes, timings, and reported usage. A local search-preparation gate checks instructions before native search becomes available. See [MEMORY.md](MEMORY.md) for supported rule types, conflict handling, limits, and testing scenarios.

## Data and privacy

The public repository contains code and synthetic tests only. `.env`, `data/`, and local review artifacts are ignored.

- Messages, selected conversation/memory context, rules, requested document excerpts, activated routine requests, relevant tool results, and the browser's time zone go to Meta. Deferred household extraction sends batches of direct user messages. Search queries are processed by Meta's search infrastructure. This prototype has no microphone or camera access.
- Requests use `store:false` and encrypted reasoning replay. Standard mode excludes model training under Meta's terms; **this is not a claim of zero retention**. Separately enabled Meta ZDR is incompatible with built-in web search.
- Exact conversation and memory records persist locally until deleted. Reloading restores the browser's session; **New conversation** starts another session while retaining household records. Active model history uses at most 12 whole turns with a size budget; older exact text remains searchable. **Delete this conversation** removes that transcript; **Delete all memory** clears conversations, household records, rules, documents, routines, queued learning, and response/trace caches. Individual deletion/correction invalidates dependent recall. No conversation text is written to the hash-only request ledger.
- `data/timers.json` stores labels, times, status, and operation IDs locally. Dismissed records remain for retry protection. `data/requests.jsonl` stores request-ID and payload hashes, not message text or keys; treat even these hashes as private. There is no automatic on-disk retention limit. To erase all local runtime data, stop the server and remove `data/`; this also removes timers and retry protection.
- `data/memory.json`, `data/memory-learning.json`, and `data/routines.json` hold private local records. Clear-all memory deliberately preserves existing timers and hash-only retry receipts; stop the server and remove `data/` only to erase every runtime file including timers and retry protection.
- Voice, timer images, device control, remote access, and authentication remain unimplemented. Semantic guidance is model context, not guaranteed enforcement. Routines expand user-defined prompts into currently available tools; they do not add missing integrations or create recurring schedules.

## Verification

```sh
npm test
git diff --check
```

Tests use temporary directories and scripted provider responses; they do not call Meta or spend credits. Coverage includes persistence/restart/expiry, cancellation, concurrent duplicates, storage failures/corruption, input validation, source URL filtering, tool-result replay, bounded loops, partial failure, host/origin checks, and missing credentials. Live verification is recorded separately in [STATUS.md](STATUS.md).

Official implementation references checked October 26, 2026: [Responses API](https://dev.meta.ai/docs/protocols/responses), [tool calling](https://dev.meta.ai/docs/tool-calling), [search grounding](https://dev.meta.ai/docs/search-grounding), [models](https://dev.meta.ai/docs/models), [terms](https://dev.meta.ai/legal/terms-of-service), and [ZDR limits](https://dev.meta.ai/help/policies-and-privacy/zero-data-retention).

## Contributions and dependencies

New application work dated October 26, 2026: local browser interface, Meta adapter/orchestration, timer persistence, request receipts, server boundary, and automated tests. Runtime/test dependencies: Node.js standard library and browser APIs; external service: Meta Model API. No downloaded UI assets or additional package licenses are introduced. The existing hackathon build-start ambiguity and repository license decision remain open; see [HACKATHON.md](HACKATHON.md).
