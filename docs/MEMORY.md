# MERLIN memory implementation and testing

This guide describes the local text prototype's memory system. Product decisions and remaining unknowns belong in [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md); verification results and current limitations belong in [STATUS.md](STATUS.md). The earlier architecture research is in [MEMORY_RESEARCH.md](MEMORY_RESEARCH.md).

MERLIN separates conversation history, overall household memory, explicit do/don't instructions, and named documents. Named routines also let an intentional trigger stand for a longer saved request. The **Memory lab** makes the records, evidence, interpretation, conflicts, retrieval, and execution checks visible while testing.

The conversation stays focused on household assistance. MERLIN gives concise practical outcomes, applies saved preferences quietly, and asks the concrete choice needed to proceed. A successful timer should receive a reply such as “Your timer is set for five minutes.” Memory categories, enforcement details, and model-call counts belong in the inspector unless the user explicitly asks how the system works. This separation does not hide an unavailable action or a failed save; those require a truthful explanation of what did not happen.

## What each category does

| Category | Stored information | What a request loads |
| --- | --- | --- |
| Conversation | Exact user messages and delivered assistant text, with session/request identifiers; private protocol records preserve complete tool calls and results for replay | Recent complete turns and relevant older message excerpts |
| Overall | Small facts, preferences, and general guidance, with subject, exact source quotation, source ID, reason, and timestamps | Relevant records plus a small selection of communication guidance |
| Do / don't | Explicit instructions represented as validated rule data with a fixed supported handler, scope, original request, and clear interpretation | Applicable code checks; compact current rules and conflict information also inform the model |
| Documents | Named text/Markdown content, description, version, and timestamps | A brief catalog first; selected exact content only when a document is read |
| Routines | A name, optional trigger phrases, and the user-defined request they represent | The selected request after an intentional activation or confirmed close match |

### Exact history versus active recall

Saving an exact transcript does **not** guarantee perfect recall. The entire archive is not sent on every request. Active conversation history preserves whole tool-call/result sequences, normally selecting at most 12 recent completed turns around a 48,000-character budget. A single larger complete turn can exceed that target; turns over 100,000 characters are omitted from active protocol replay. Older retained text remains available to memory search.

Retrieval is local keyword/name matching, not an embedding database or a guarantee of semantic matching. The model can search again with different words. It should say when evidence is unavailable instead of constructing a plausible personal detail. A source quote proves that the words were present; it does not prove that the model interpreted them correctly. Inspect the original quote when evaluating a learned record.

### Overall household learning

Household learning runs in a durable background queue after replies. It uses direct user messages, never unrelated ambient conversations, assistant claims, web-page instructions, or document content as permission to create a household preference. MERLIN still has one shared household identity; named attribution is retained when the user supplies it, without claiming speaker recognition.

The extractor is instructed to preserve negation, uncertainty, named subjects, and temporary qualifiers. “I bought oat milk today” must not automatically become “I always prefer oat milk.” Routine commands, hypothetical examples, and small talk need not produce any memory.

Explicit remember requests, corrections, and standing instructions use synchronous memory tools so they can affect later actions in the same request. Background extraction cannot create executable rules or silently replace an existing fact. Failed extraction remains visible and can be retried from Memory lab.

Each background batch is bounded to a few messages and a limited current-fact context. Queued work carries a memory epoch: deletion or correction invalidates obsolete work so a late model response cannot recreate forgotten information. Prepared extraction results are persisted for recovery from local write failures and invalidated when their source becomes obsolete.

## Supported do/don't rules

On the model path, the model interprets the request once and supplies structured values. A narrow local parser also handles supported complete timer-default declarations, as described below. Trusted local handlers apply the saved values; generated JavaScript, shell commands, and arbitrary regular expressions are not executed.

| Rule kind | Scope | Meaning |
| --- | --- | --- |
| `timer_default_seconds` | `timers` | Use the saved whole duration only when a timer request omits its entire duration; integer from 1 to 604800 seconds |
| `timer_default_unit` | `timers` | Use seconds, minutes, or hours when a timer request supplies a number but omits its unit |
| `timer_max_seconds` | `timers` | Reject a duration exceeding the saved limit |
| `address_as` | `assistant_reply` | Add the saved form of address to replies if needed |
| `avoid_word` | `assistant_reply` | Block a literal word with case-insensitive, Unicode-aware matching |
| `avoid_phrase` | `assistant_reply` | Block a literal phrase, case-insensitively, with word-like edge boundaries |
| `response_prefix` | `assistant_reply` | Apply required opening text |
| `response_suffix` | `assistant_reply` | Apply required closing text |
| `tool_deny` | `tools` | Block `create_timer`, `cancel_timer`, or `web_search` |

The UI displays the scope and interpreted meaning. These scopes describe the current text prototype. An assistant-reply wording rule does not erase original quotations or technical records from the inspector; the inspector must still let the owner see and edit them. Voice, device displays, and future integrations need explicit supported scopes before claiming equivalent coverage.

“Do not mention upsetting animal stories” is a meaning-based preference. If its meaning cannot be represented faithfully by a supported handler, save it in Overall as **guidance**, with the reason it is not code-enforced visible in the inspector. The conversational acknowledgment should stay useful and brief without promising infallibility. Do not silently turn a topic restriction into a list of banned spellings. Unsupported music or device actions also must not be described as implemented enforcement. A whole timer duration is supported: “My default timer is five minutes” saves `timer_default_seconds: 300`, not guidance.

### Conflicts and action checks

Conflicting instructions remain present and flagged; the latest one does not silently win. Saving a conflicting value does not force an immediate clarification. A later action that needs the conflicting setting is blocked while MERLIN asks which instruction should apply. The owner can resolve the conflict in conversation or choose a retained rule in Memory lab.

For example, conflicting whole-duration defaults of five and ten minutes block “set me a timer,” with a practical question such as “Should I use five minutes or ten minutes for this timer?” Conflicting default units of seconds and minutes block “start a timer for 5.” “Start a timer for 5 minutes” is explicit and does not need either kind of default. A whole-duration default does not supply a unit for a different stated number, and a unit default does not invent a missing amount. A separate maximum-duration restriction still applies. A conflict involving text required in every reply affects the next reply.

Within a batch, memory writes run before dependent actions. Memory-enabled model timer calls use `duration:null, unit:default` when the entire duration is missing; a positive number with `unit:default` requests the saved unit; a stated amount and unit are passed explicitly. Zero is invalid and cannot mean “use the default.” Legacy preconverted `duration_seconds` model calls cannot bypass these checks. Without a usable default, MERLIN asks for the missing duration or unit. The manual timer test form also passes the applicable local action checks.

The provider boundary narrowly normalizes two serialization forms observed in live model calls before strict validation. For integer-valued rules only, a bounded decimal string representing an exact whole number, such as `"420.0"`, becomes numeric `420` and still must pass the compiler's range checks. For `create_timer`, the exact string `"null"` becomes JSON `null` only with `unit:default`. Numeric timer strings, zero placeholders, arbitrary coercions, and other malformed values remain invalid. The rule compiler and manual API still require the strict typed forms.

Native web search executes at the provider. To apply new rules before that external action, the model first calls local `prepare_web_search`. Only a successful preparation enables native search on a later model round in the same request. A web-search ban saved in the preparation batch is checked first. This adds a model round to search requests.

Every final assistant reply passes the local output checker. A prohibited model draft receives at most one rewrite attempt, with all tools disabled. Tool calls proposed during that repair cannot execute. Rejected drafts are removed from replay history. If a valid reply still cannot be produced, the application uses checked fallback wording and preserves actual action outcomes; it does not claim success merely because the model proposed an action. The simple local timer route uses checked local fallback wording without adding a model call.

### Simple timer requests without a foreground model call

A local parser recognizes complete simple declarations such as “default timer is five minutes” and the same declaration followed by “set me a timer.” It also recognizes a bare “set me a timer” when a whole-duration default already exists. Before choosing this route, MERLIN performs the same memory-context selection as the model path. Any selected household fact, preference, or guidance sends the request to Meta for interpretation. When none are selected, the local route saves exact source evidence, applies current rules, persists the result, and produces checked concise replies with **zero foreground model calls**. Saving alone does not start a timer. A conflict still blocks a dependent start; an applicable timer limit or tool ban still applies.

This route deliberately covers a small command grammar, including the observed “defualt” typo. Questions, quoted examples, negation, extra qualifiers, and unrelated compound work do not grant actions through a substring match. Broader wording goes through the normal Meta/tool loop; a bare start without a whole-duration default also falls back to that loop. Active routine requests use their existing model path. The inspector records the selected route and model-call count, while the ordinary reply states the useful outcome. Background learning may still process the user turn later, so zero foreground calls does not mean no later provider traffic.

## Documents and routines

Documents accept pasted text or `.txt`/`.md` files up to 100,000 characters. PDF, Word, image OCR, and other file formats are not implemented by this importer. Titles and short descriptions form a catalog; a catalog entry is not the full source.

`memory_search` returns matching records and bounded snippets. `memory_read_document` returns a relevant section or bounded contiguous excerpt, with its heading, current version, exact start/end offsets, and truncation flags. The normal assistant read is limited to 12,000 characters. Replacing a document keeps its current content and increments its version; dependent old recall is invalidated. Large plans may need additional searches or reads rather than treating the first excerpt as the complete plan.

Routines are user-authored requests, not predetermined actions. Saving a routine does not execute it and does not create a recurring schedule. An intentional command matching the saved name or alias activates the saved request once. Matching uses the complete normalized command, allowing supported wrappers such as “Merlin, tea break,” “start tea break,” or “I'm going to workout.” Case, whitespace, and terminal periods/exclamation marks are normalized. A question mark prevents direct activation; “What should I eat before my workout?” does not run a workout routine.

When the model proposes a related but non-exact routine, MERLIN records a visible pending proposal instead of running it. The ordinary model call compares current intent to the catalog; there is no extra classifier call. A narrow final-text guard also records an unambiguous activation question if the model omits the suggestion tool. It never authorizes execution. Semantic similarity can still be missed or misinterpreted; exact trigger guards and confirmation remain local. A standalone confirmation such as “yes,” “yes please,” “okay,” or “do it” must follow in the same session within ten minutes. An unrelated intervening turn invalidates the proposal. Routine edits/deletion also invalidate it. The expanded request uses the available assistant tools and current rules, so missing device/music integrations remain unavailable. Up to 100 routines are supported, each with an 80-character name, up to 12 aliases of 120 characters, and a 12,000-character saved request.

## Inspecting and testing

Start the local application with `npm start` and open its printed browser address. Typed conversation requires a configured standard Meta API key. Memory-lab editing and direct timer checks can be exercised without inference. Use synthetic examples for public demos and automated tests.

The **Memory lab** provides:

- **Conversation:** exact saved messages for the current session and a delete-conversation control.
- **Overall:** facts, preferences, guidance, original evidence, and edit/delete controls.
- **Do / don't:** original instructions, compiled values/scopes, conflicts, and explicit conflict resolution.
- **Documents:** catalog, complete text inspection, import, replacement, and deletion.
- **Routines:** names, aliases, saved request text, and pending activation confirmation.
- **Memory activity:** recent learning operations, counts, timing, failures, and retry state.

Expand **Behind this response** to inspect recorded request stages: selected record IDs, context size, model-call count, provider-reported token usage where available, action checks, actual results, output checks, and elapsed times. This is an execution trace, **not hidden chain-of-thought**. Neither encrypted reasoning nor private reasoning summaries are exposed by the memory/trace endpoints. Missing usage is not proof of zero provider cost.

Useful manual scenarios:

| Scenario | Expected observation |
| --- | --- |
| “Default timer is five minutes,” then “set me a timer” | Whole-duration rule stores 300 seconds; each request reports zero foreground model calls when no household facts/preferences/guidance are selected; the second creates a five-minute timer with a concise acknowledgment |
| “Defualt timer is five minutes, set me a timer” | The sourced default is saved before the timer starts; the same context-selection condition governs use of the local route |
| Save relevant household guidance, then send a simple timer request | The trace shows the selected record IDs and a model route so the guidance can be interpreted |
| Save a second whole-duration default of ten minutes, then “set me a timer” | Both durations remain flagged; the start asks which duration to use and creates no timer |
| “Always use seconds when I omit timer units. Start a tea timer for 5.” | A sourced rule is saved before the timer action; the timer is five seconds |
| Then save “Always use minutes when I omit timer units.” | Both defaults remain visible with a conflict flag |
| “Start a timer for 5.” | No affected timer is created; MERLIN asks which default should apply |
| “Start a timer for 5 minutes.” | Explicit units work despite the default-unit conflict, subject to other applicable rules |
| “Never say the exact word cactus in replies.” | A literal rule appears; drafts are checked without converting it into a broad plant-topic restriction |
| “Avoid upsetting animal stories.” | Overall guidance explains that this is not an exact code-enforced rule |
| “Remember that Alex prefers oat milk.” | A sourced, attributed preference appears; inspect the exact quote and interpretation |
| Import a named weekly plan, then ask about one section | The trace shows catalog selection and a document read instead of loading every document |
| Save a routine named “Tea break,” then discuss its name before activating it | Discussion does not run it; an intentional activation runs only the authored request |
| Delete a remembered fact after recalling it | The fact, related source/recall records, stale traces, cached replies, and obsolete learning work stop being usable |
| Delete all memory | Conversations, household records, rules, documents, routines, and learning work are cleared; existing timers remain separate |

Run `npm test` for the complete automated suite. Memory-specific tests live in `test/memory-store.test.js`, `test/memory-rules.test.js`, `test/memory-learning.test.js`, `test/memory-integration.test.js`, and `test/meta-memory.test.js`. `test/timer-default-integration.test.js` covers parser boundaries, the two-turn default-duration flow, zero-call handling, persistence, conflicts, explicit overrides, and governed execution. Routine tests cover the separate matcher/store and HTTP flow. The tests use temporary files, synthetic data, and scripted provider responses. They do not establish live model interpretation quality or real response latency. Record live checks and performance measurements separately in [STATUS.md](STATUS.md).

## Retention, deletion, and privacy

This local prototype retains records until they are deleted. This is the visible testing behavior; a production retention duration remains undecided. Runtime files live under ignored `data/`, outside the public tracked assets. Memory/learning stores use serialized mutations, atomic file replacement, and owner-only file permissions. Corrupted files cause a clear initialization failure and are not silently overwritten.

Deleting a fact removes its supersession chain and related source request pairs. Assistant records carry memory dependencies, so related answers in other sessions can also be removed while unrelated conversations remain. Affected protocol history and cached traces/results are invalidated. Corrections exclude superseded facts from active recall while retaining their revision records until deletion. Document replacement similarly invalidates references to old content. Deleting a conversation removes its transcript; already established household records are kept unless separately deleted. “Delete all memory” is the broader reset and does not cancel timers.

Storage is local; inference is not. Model-handled requests send selected history, current rules, relevant household evidence, document excerpts when read, and routine requests when activated to Meta. Background batches of direct user messages also go to Meta, including eligible turns whose immediate reply used the local timer route. The configured model is standard `muse-spark-1.3`; Contributor variants are disabled. Requests use `store:false`, which is not a claim of zero provider retention. See [MODELS.md](MODELS.md) for the provider/privacy distinction. No extra external memory service or vector database is involved.

Keep public fixtures synthetic. Do not commit `data/`, API credentials, private household information, device addresses, or recorded home audio/video. Deleting local application records does not claim to remove independent backups, browser screenshots, or data already handled under the provider's terms.

## Limits and next evaluation

The store is a single-process JSON implementation. Each committed mutation rewrites the complete file; archive growth increases local I/O, parsing, and retrieval work. A database/index and an explicit retention policy should be evaluated before claiming indefinite scale. Saved rule lists also grow the active prompt; the trace exposes context size so this cost can be measured.

Fast local rule checks and delayed household learning avoid an extra extraction call on the ordinary reply path. The narrow simple-timer route also avoids foreground inference and model restatement of a completed local result. Broader explicit saves, document reads, tool execution, search preparation, and occasional output repair can still require extra model rounds. Replies are not streamed yet because final wording is checked before delivery. Provider/model latency, retrieval quality, and end-to-end timing require measurement; this implementation does not promise a response-time target or perfect personal recall.
