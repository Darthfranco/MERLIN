# MERLIN model and voice reference

Last checked: **2026-10-26**. This records the founder's supplied catalog and initial preferences, cross-checked against the linked primary documentation. Prices are a dated planning snapshot in USD, not a spending authorization or guarantee of account access.

## Selected direction and open choices

- **Selected direction:** build MERLIN around Meta AI capabilities for the Meta hackathon.
- **Tentative preference:** Kokoro for MERLIN's spoken replies.
- **Confirmed interaction:** wake-word activation and learning from direct conversations, with one shared household identity initially. Exact wake phrase, detection implementation, and Meta's role in the voice pipeline remain TBD.
- **Catalog roles:** the models below are candidates apart from Spark 1.3 in the initial text prototype. The product does not need to use every listed model.
- **Prototype implementation:** standard `muse-spark-1.3` on Meta Model API, using Responses with built-in `web_search` and local timer functions. Authenticated model-list access and live timer creation/cancellation/search were checked on October 26, 2026. This is a first-slice adapter choice, not final model routing or a performance benchmark. See [PROTOTYPE.md](PROTOTYPE.md).
- **Still open:** final reasoning/model routing, hosting, device gateway, production orchestration, voice deployment, storage, authentication, and hardware.

An SDK with another provider's name does not by itself determine the model provider. Meta documents compatible API clients and the base URL `https://api.meta.ai/v1`; credentials belong on the trusted server or local runtime, never in a public repository or shipped client. [Meta API overview](https://dev.meta.ai/docs/overview)

## Catalog and pricing snapshot

The founder provided these model names, capabilities, and prices. The official [Meta model catalog](https://dev.meta.ai/docs/models) confirms the hosted IDs and access distinctions below. Wonder and the hosted Spark versions have 1,048,576-token context windows. Wonder Full is a separate Muse Code subscription offering, not an API model unlocked by raising reasoning effort.

For text models, **input / cached input / output** prices below are **per one million tokens**. The supplied prices match the [official pricing page](https://dev.meta.ai/docs/pricing-rate-limits) on the check date.

| Model | API ID or access | Price snapshot | Candidate MERLIN role |
| --- | --- | --- | --- |
| Muse Wonder | `muse-wonder-1.0` | $4.00 / $0.20 / $20.00 | Complex planning and longer agent tasks |
| Muse Wonder Full | Muse Code Power Usage or Maximum Usage subscription; no Model API access | Included in eligible subscription; no API token rate | Development assistance if separately available |
| Muse Spark 1.3 | `muse-spark-1.3` | $1.25 / $0.15 / $4.25 | Everyday conversation and device-tool orchestration |
| Muse Spark 1.3 Contributor | `muse-spark-1.3-contributor` | $0.10 / $0.002 / $0.20 | Optional synthetic-data evaluation; not a default for household data |
| Muse Spark 1.2 | `muse-spark-1.2` | $1.25 / $0.15 / $4.25 | Alternative to evaluate if useful |
| Muse Spark 1.2 Contributor | `muse-spark-1.2-contributor` | $0.10 / $0.002 / $0.20 | Optional synthetic-data evaluation; not a default for household data |
| Muse Spark 1.1 | `muse-spark-1.1` | $1.25 / $0.15 / $4.25 | Earlier alternative; Standard mode only |
| Muse Voice Transcribe | `muse-voice-transcribe-1.0` | $0.18 per hour of audio processed | Voice input and transcription |
| Muse Image 1.0 | `muse-image-1.0` | $0.01 per generated image | Quick timer labels and optional visual assets |
| SAM 3.1 | `sam-3.1` | $2.50 per 1,000 images; $0.20 per 1,000 video frames | Optional object segmentation and tracking |
| Muse Spark Open | Download / self-host / third-party hosted inference; outside Meta Model API | Compute or provider costs to evaluate | Optional deployment exploration |
| Muse Glimmer | Download / self-host; outside Meta Model API | Hardware and operating costs to evaluate | Optional local home-agent exploration |

SAM video billing has a 50-frame minimum per request. Text-model web search grounding adds $2.50 per 1,000 queries. Cached-input savings depend on actual cache hits. Rate limits apply to the team; do not infer live quota or eligibility from a catalog listing. [Meta pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits)

Spark Open uses the Muse Model License; its infrastructure requirements need evaluation before considering it for home hardware. [Spark Open documentation](https://dev.meta.ai/docs/muse-spark-open) Glimmer is a 30B model with Apache 2.0 weights. The founder's catalog describes single-GPU operation; actual fit, quantization, and responsiveness on our hardware remain untested. [Glimmer documentation](https://dev.meta.ai/docs/muse-glimmer)

## Voice and camera boundaries

The proposed voice path is wake-word activation → conversational audio → transcription → reasoning and permitted tools → response text → context-aware standing-instruction check → Kokoro speech. This is a conceptual pipeline, not a selected implementation. Wake-word detection does not authorize retaining, uploading, or learning from unrelated room conversations. Muse Voice Transcribe handles speech input; it does not synthesize speech. [Meta voice overview](https://dev.meta.ai/docs/overview)

Keep background preference learning separate from explicit do/don't instructions. The text prototype applies compiled exact output and tool rules locally. Unsupported semantic guidance remains model context, with no guarantee of deterministic enforcement; voice channels remain TBD. Once established, scheduled automations run through ordinary execution logic without a fresh model call per execution.

The founder linked the [official Kokoro demo Space](https://huggingface.co/spaces/hexgrad/Kokoro-TTS). The [Kokoro-82M model card](https://huggingface.co/hexgrad/Kokoro-82M) describes an open-weight, Apache-licensed text-to-speech model. Treat the Space as a reference/demo; a production endpoint, local deployment, voice, runtime, licensing obligations, and hosting cost have not been chosen or tested.

For cameras, separate general visual questions such as “what is this?” from optional SAM segmentation. A model's ability to interpret images does not grant access to a camera. Integrations must enforce device permissions and disclose when capture is active.

## Privacy and evaluation requirements

Contributor mode permits Meta to use submitted content and responses for model training. Standard mode's no-training policy is not a blanket assertion of zero retention. [Meta pricing modes](https://dev.meta.ai/docs/pricing-rate-limits)

**Never automatically route home audio, camera footage, preferences, schedules, or other household information through Contributor models.** Cost-based routing must preserve the chosen privacy mode. Use synthetic fixtures for public demos and development wherever possible; keep private recordings, credentials, and household data out of GitHub.

Before committing an integration, verify available models using the account's model listing, inspect current terms and limits, and test a small representative flow. Measure response latency, speech interruption, transcription accuracy, tool reliability, and real cost. Record the result and the selected model here; keep catalog claims distinct from tested MERLIN behavior.

## Text-prototype API contract

The implementation calls `POST https://api.meta.ai/v1/responses`, with standard model IDs, `store:false`, encrypted reasoning replay, flat function definitions, and actual function-call outputs. Web search runs within Meta and returns execution events and URL annotations; timer creation/list/cancel runs in MERLIN after validation. See [Responses](https://dev.meta.ai/docs/protocols/responses), [tools](https://dev.meta.ai/docs/tool-calling), and [search](https://dev.meta.ai/docs/search-grounding), checked October 26, 2026.

Compound requests now enable `parallel_tool_calls:true` so Meta can emit several timer functions together and combine them with built-in search. A shared per-request search budget is passed as `max_tool_calls` on each model round; local calls and rounds are separately bounded. A live standard Spark 1.3 request created ten timers and answered two distinct searches with NASA/NOAA citations on October 26, 2026. This verifies a representative combined flow, not every possible prompt.

The API key stays in ignored server configuration. Standard mode does not use content for training; Meta terms still permit some retention. `store:false` is not ZDR, and separately enabled [ZDR disables web search](https://dev.meta.ai/help/policies-and-privacy/zero-data-retention). No Contributor model or alternate-provider fallback is enabled.

## Memory and routine implementation

The same standard Spark adapter interprets standing instructions and selects memories/routines within the ordinary request. Main responses use low reasoning effort; deferred household extraction uses minimal effort and a strict JSON schema with exact source quotations. Background extraction cannot create executable rules or overwrite explicit corrections. No separate coding API or arbitrary code runner was introduced. [Reasoning](https://dev.meta.ai/docs/reasoning) and [structured output](https://dev.meta.ai/docs/structured-output) were checked October 26, 2026.

Native web search is initially withheld. A local `prepare_web_search` function checks current saved restrictions before search becomes available on the next model round. This adds a round to searches, while ordinary replies require no separate memory-check model call. Exact output violations allow one tool-free repair attempt. Routine matching uses the existing main-model call plus local activation guards; starting a routine expands its saved request for subsequent execution. Observed timings and limits are recorded in [STATUS.md](STATUS.md), not inferred from model specifications.
