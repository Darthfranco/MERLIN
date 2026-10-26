# MERLIN text prototype

This is the first application slice requested by the owner on October 26, 2026: **typed request → Meta chooses a tool → execution → text reply**. It implements web search and multiple labeled countdown timers. It does not replace the full product scope or select the final app platform.

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

Timers show running, finished, and cancelled states with local-time deadlines and an explicit time zone. Cancel and Dismiss buttons work directly; dismissal hides a finished/cancelled timer. Keep the server running and page open for visible completion. There is no alarm sound, background browser notification, wake lock, or delivery while the machine sleeps. Overdue timers reconcile when the server resumes/restarts.

## Execution and boundaries

- `src/meta.js` calls the **Meta Responses API**. Built-in `web_search` executes inside Meta; custom timer functions execute locally. Search events are reported from actual `web_search_call` output, and returned URL citations become safe clickable source links. A failed search or missing citation is not fabricated into a success or source.
- `src/assistant.js` advertises `create_timer`, `list_timers`, and `cancel_timer`, validates arguments, returns real results to Meta, and caps the loop at five model rounds/eight local calls. A request can make up to three built-in search calls per round. Only complete responses/function calls execute. Unknown tools fail closed. Partial success stays visible if the final model response fails.
- The model receives direct-user authorization rules and treats retrieved content as data. As an additional prototype boundary, local timer mutations after a web search in the same turn are refused; ask for the timer separately. This is not a general solution for adversarial content or the future household permission system.
- `src/timers.js` uses absolute UTC deadlines with explicit named time zones, atomic file replacement, serialized writes, and stable operation IDs. One-time duration timers accept 1–604800 seconds and labels of 1–80 characters, with at most 50 running timers. Clock-time alarms and recurring schedules are not implemented. Timer completion uses ordinary server scheduling, with no model call.
- `src/requests.js` records a hash-only receipt before a request can run. Concurrent retries with the same request ID share one result. Reusing an ID with different input fails. After restart/cache expiry, an already attempted ID is refused rather than re-executed; inspect timers before submitting a new request. Received errors show known tool results; uncertain browser disconnects keep the ID for an explicit retry. No automatic model retries occur.
- `src/server.js` permits only loopback hosts, checks Origin, requires JSON for mutations, limits request size, and serves only the three UI files. The runtime lock prevents a second normal server from writing the same timer file. This is a single-process prototype; do not share `data/` between runtimes.

## Data and privacy

The public repository contains code and synthetic tests only. `.env`, `data/`, and local review artifacts are ignored.

- Messages, recent conversation context, relevant timer tool results, and the browser's time zone go to Meta. Search queries are processed by Meta's search infrastructure. This prototype has no microphone or camera access.
- Requests use `store:false` and encrypted reasoning replay. Standard mode excludes model training under Meta's terms; **this is not a claim of zero retention**. Separately enabled Meta ZDR is incompatible with built-in web search.
- Conversation context stays in server memory (up to 12 whole turns, with a size cap). Clear conversation removes that session's context. Reloading starts a new conversation. Inactive sessions are pruned when another chat starts after one hour; restarting clears them. Request-result caches remain in memory for up to an hour to protect retries, including after clearing conversation. No conversation text is written to the request ledger.
- `data/timers.json` stores labels, times, status, and operation IDs locally. Dismissed records remain for retry protection. `data/requests.jsonl` stores request-ID and payload hashes, not message text or keys; treat even these hashes as private. There is no automatic on-disk retention limit. To erase all local runtime data, stop the server and remove `data/`; this also removes timers and retry protection.
- No long-term household learning, configurable do/don't list, voice, timer images, device control, remote access, or authentication is implemented. In-conversation instructions are model context, not the planned persistent standing-instruction checker.

## Verification

```sh
npm test
git diff --check
```

Tests use temporary directories and scripted provider responses; they do not call Meta or spend credits. Coverage includes persistence/restart/expiry, cancellation, concurrent duplicates, storage failures/corruption, input validation, source URL filtering, tool-result replay, bounded loops, partial failure, host/origin checks, and missing credentials. Live verification is recorded separately in [STATUS.md](STATUS.md).

Official implementation references checked October 26, 2026: [Responses API](https://dev.meta.ai/docs/protocols/responses), [tool calling](https://dev.meta.ai/docs/tool-calling), [search grounding](https://dev.meta.ai/docs/search-grounding), [models](https://dev.meta.ai/docs/models), [terms](https://dev.meta.ai/legal/terms-of-service), and [ZDR limits](https://dev.meta.ai/help/policies-and-privacy/zero-data-retention).

## Contributions and dependencies

New application work dated October 26, 2026: local browser interface, Meta adapter/orchestration, timer persistence, request receipts, server boundary, and automated tests. Runtime/test dependencies: Node.js standard library and browser APIs; external service: Meta Model API. No downloaded UI assets or additional package licenses are introduced. The existing hackathon build-start ambiguity and repository license decision remain open; see [HACKATHON.md](HACKATHON.md).
