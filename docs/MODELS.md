# MERLIN model and voice reference

Last checked: **2026-10-26**. This records the founder's supplied catalog and initial preferences, cross-checked against the linked primary documentation. Prices are a dated planning snapshot in USD, not a spending authorization or guarantee of account access.

## Selected direction and open choices

- **Selected direction:** build MERLIN around Meta AI capabilities for the Meta hackathon.
- **Tentative preference:** Kokoro for MERLIN's spoken replies.
- **Candidates, not selections:** the individual models below and their proposed roles. The product does not need to use every listed model.
- **Still open:** main reasoning model, hosting, device gateway, orchestration framework, voice deployment, storage, authentication, and hardware. No implementation or model benchmark has been completed.

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

The proposed voice path is microphone → transcription → reasoning and permitted tools → response text → Kokoro speech. Muse Voice Transcribe handles speech input; it does not synthesize speech. [Meta voice overview](https://dev.meta.ai/docs/overview)

The founder linked the [official Kokoro demo Space](https://huggingface.co/spaces/hexgrad/Kokoro-TTS). The [Kokoro-82M model card](https://huggingface.co/hexgrad/Kokoro-82M) describes an open-weight, Apache-licensed text-to-speech model. Treat the Space as a reference/demo; a production endpoint, local deployment, voice, runtime, licensing obligations, and hosting cost have not been chosen or tested.

For cameras, separate general visual questions such as “what is this?” from optional SAM segmentation. A model's ability to interpret images does not grant access to a camera. Integrations must enforce device permissions and disclose when capture is active.

## Privacy and evaluation requirements

Contributor mode permits Meta to use submitted content and responses for model training. Standard mode's no-training policy is not a blanket assertion of zero retention. [Meta pricing modes](https://dev.meta.ai/docs/pricing-rate-limits)

**Never automatically route home audio, camera footage, preferences, schedules, or other household information through Contributor models.** Cost-based routing must preserve the chosen privacy mode. Use synthetic fixtures for public demos and development wherever possible; keep private recordings, credentials, and household data out of GitHub.

Before committing an integration, verify available models using the account's model listing, inspect current terms and limits, and test a small representative flow. Measure response latency, speech interruption, transcription accuracy, tool reliability, and real cost. Record the result and the selected model here; keep catalog claims distinct from tested MERLIN behavior.
