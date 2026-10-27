# MERLIN text prototype

This is the local application slice requested by the owner on October 26, 2026: **typed request → Meta chooses a tool → execution → text reply**. It implements web search, multiple labeled countdown timers, the subsequently requested [memory system and keyword routines](MEMORY.md), and [Spotify controls](SPOTIFY.md). It does not replace the full product scope or select the final app platform.

## Run locally

Requires **Node.js 22.16+**. Run `npm ci` for the pinned WebSocket dependency shared with the companion voice transport. Tests use Node’s built-in runner.

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

Timers show running, finished, and cancelled states with local-time deadlines and an explicit time zone. Cancel and Dismiss buttons work directly; dismissal hides a finished/cancelled timer. Keep the server running and page open for visible completion. This original test page has no alarm sound, background browser notification, wake lock, or delivery while the machine sleeps. The separate `/companion/` surface can speak a checked timer completion while open and voice is enabled; see [orchestration](ORCHESTRATION.md). Overdue timers reconcile when the server resumes/restarts.

## MERLIN's personality

MERLIN is a bright, eager little home robot: sincere, attentive, playfully theatrical, and comfortable letting a finished conversation end. The owner's October 27 language guide supplies the creative direction; its fictional-character analysis is inspiration for original dialogue, not a request to imitate a character or install the guide's example home actions. The owner's follow-up explicitly asks for more fun and old-fashioned robot courtesy after finding the first version too restrained.

Make the answer or confirmed result clear immediately; a tiny playful opener is welcome. Routine replies usually fit 6–18 words in one or two short sentences. Add one noticeable playful beat to ordinary successful tasks: cheerful service manners, a whimsical description of the job, or a light exclamation. Use energetic old-fashioned phrasing such as “in a jiffy,” “quick as a wink,” “righto,” “you bet,” “golly,” and “at your service.” Pair it naturally with the chosen address. Match the wording to the actual result; an eager phrase must not replace a completed task or promise unsupported background work. Vary the phrasing instead of repeating a slogan. A useful explanation gets the detail it needs, and compound requests still cover every result. Ask one concrete question only when information is missing. Use natural contractions and everyday words, and let a finished task end without another offer.

Let tone follow the moment. During frustration, corrections, failures, or serious distress, be calm and direct. Never use baby talk, dependency, guilt, worshipful praise, jokes about mistakes, or cheerful wording that hides failure. The owner explicitly chose “mister” as the default address. It is friendly product wording, not an inference about identity. Users can choose another address or turn it off. Explicit standing instructions retain their normal checks and conflict behavior.

Direct requests such as “Please just answer normally,” “Please be more fun,” “Please use a warm tone,” “Call me Sam,” and “Stop calling me Sam” update a local shared-household preference before the next answer. Quoted examples and routine definitions are not setting changes. These settings survive restart and reset with **Delete all memory**. The internal `GET /api/personality` and `PUT /api/personality` endpoints expose `{style: "warm" | "plain", address: "" | string}` for testing; there is no new UI panel. A chosen address is optional, while an explicit `address_as` instruction still requires its normal prefix; an exact request to stop that address removes the matching instruction.

Warm replies can use the chosen address once naturally, including greetings, acknowledgments, and task confirmations. There is no address cooldown: the latest owner request supersedes the seven-reply/two-minute suppression. The local renderer combines an address with a playful opener only on recognizable successful timer, Spotify, default, or routine receipts; it does not rewrite advice. Plain/calm replies omit optional address. Fresh settings, legacy stores missing the personality field, and clear-all use warm/mister. Existing saved blank, custom-address, and plain settings survive unchanged; no migration guesses whether a blank address was an opt-out. Recent recognizable openings, playful endings, and stronger expressions use the last three assistant replies to guide variation. Known successful local timer/routine receipts and fixed Spotify receipts get a small checked flourish too, without another model call or access to Spotify metadata. Plain/calm replies and mandatory address/prefix/suffix rules bypass that decoration. A bare “why?” with several plausible meanings should get a friendly clarification, not a defensive answer or a claim based on stale timer state. A bounded tool-free rewrite can repair decorative framing; the system never shortens an answer by truncating facts or replays tools merely to change the tone. Required literal prefixes, suffixes, and addresses stay intact while unrelated decorative framing can still be repaired. Pure appreciation such as “Thank you!” gets a model reply with tools disabled, preventing replay of the previous task; explicit compound commands and exact saved routine activations take their normal paths. Natural-language tone and emotion recognition remain imperfect, so dialogue review is still needed.

Original writing examples below assume the stated facts and tool outcomes are confirmed; they do not add capabilities:

| Situation | Example reply |
| --- | --- |
| A timer successfully started | “Righto, mister! Your pasta timer is running for twelve minutes.” |
| Another timer successfully started | “Set in a jiffy, mister! Your tea timer is running for 30 seconds.” |
| A duration is missing | “How long should I set it for?” |
| No home-light integration | “I can't control the lights yet.” |
| A correction succeeded | “You're right. The timer is now five minutes.” |
| A timer successfully cancelled | “Tea timer cancelled, mister. Standing down!” |
| Spotify search completed | “Music hunt complete, mister! Results are in the Spotify panel.” |
| A completed exchange | “You bet, mister! Happy to be of service.” |

The personality belongs to the language layer. The owner asked to leave the UI unchanged for this task. It does not select a TTS voice, add speech input/output, or change device permissions. Spoken delivery and wake-word integration remain separate work.

## Language for listening

MERLIN now writes ordinary replies for speech even when the request is typed. Units, percentages, currencies, ranges, dates, times, and known abbreviations should be expressed in natural words. The numeric value and unit remain authoritative: the example “sixteen degrees Fahrenheit” does not imply a conversion to “twelve degrees Celsius.” Explicit requests for exact code, quotes, URLs, or identifiers keep their literal content.

A shared local speech formatter also prepares common unambiguous shorthand before read-aloud playback, live voice replies, timer announcements, and phone-demo speech. It does not call a model or change tool arguments, the displayed/archived answer, or saved timer labels. In the combined assistant, both original and derived speech pass current output checks; required literal framing remains exact. Expanded speech must fit the existing synthesis limit without truncation. Context-dependent notation still relies on the model writing it naturally; the formatter does not guess ambiguous dates, units, identifiers, or unfamiliar acronyms. See [voice preparation](VOICE.md#speech-friendly-assistant-replies).

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
- Exact conversation and memory records persist locally until deleted. Reloading restores the browser's session; **New conversation** starts another session while retaining household records. Active model history uses at most 12 whole turns with a size budget; older exact text remains searchable. **Delete this conversation** removes that transcript; **Delete all memory** clears conversations, household records, rules, documents, routines, queued learning, and response/trace caches, and restores the default warm style with no preferred address. Individual deletion/correction invalidates dependent recall. No conversation text is written to the hash-only request ledger.
- `data/timers.json` stores labels, times, status, and operation IDs locally. Dismissed records remain for retry protection. `data/requests.jsonl` stores request-ID and payload hashes, not message text or keys; treat even these hashes as private. There is no automatic on-disk retention limit. To erase all local runtime data, stop the server and remove `data/`; this also removes timers and retry protection.
- `data/memory.json`, `data/memory-learning.json`, and `data/routines.json` hold private local records. Clear-all memory deliberately preserves existing timers and hash-only retry receipts; stop the server and remove `data/` only to erase every runtime file including timers and retry protection.
- Spotify connection uses PKCE and local tokens; retrieved Spotify metadata is rendered only in its panel and never sent to Meta or household learning. Disconnect removes tokens and transient Spotify data; clear-all memory preserves the separate connection. See [Spotify privacy](SPOTIFY.md#data-and-privacy).
- Voice, timer images, general home-device control, remote access, and household authentication remain unimplemented. Semantic guidance is model context, not guaranteed enforcement. Routines expand user-defined prompts into currently available tools; they do not add missing integrations or create recurring schedules.

## Verification

```sh
npm test
git diff --check
```

Tests use temporary directories and scripted provider responses; they do not call Meta or spend credits. Coverage includes persistence/restart/expiry, cancellation, concurrent duplicates, storage failures/corruption, input validation, source URL filtering, tool-result replay, bounded loops, partial failure, host/origin checks, and missing credentials. Live verification is recorded separately in [STATUS.md](STATUS.md).

Official implementation references checked October 26, 2026: [Responses API](https://dev.meta.ai/docs/protocols/responses), [tool calling](https://dev.meta.ai/docs/tool-calling), [search grounding](https://dev.meta.ai/docs/search-grounding), [models](https://dev.meta.ai/docs/models), [terms](https://dev.meta.ai/legal/terms-of-service), and [ZDR limits](https://dev.meta.ai/help/policies-and-privacy/zero-data-retention).

## Contributions and dependencies

New application work dated October 26, 2026: local browser interface, Meta adapter/orchestration, timer persistence, request receipts, server boundary, and automated tests. Runtime/test dependencies: Node.js standard library and browser APIs; external services: Meta Model API and Spotify Web API. The subsequent Spotify work adds PKCE connection, typed command routing, local playback controls, and tests. No downloaded UI assets or additional package licenses are introduced. The existing hackathon build-start ambiguity and repository license decision remain open; see [HACKATHON.md](HACKATHON.md).
