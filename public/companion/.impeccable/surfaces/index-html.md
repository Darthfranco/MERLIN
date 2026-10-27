---
version: 1
slug: "index-html"
primary_target: "index.html"
related_targets: ["companion.css", "app.js", "orchestrator.js", "voice-client.js", "timer-alerts.js"]
---

# MERLIN at home

## Scope and mode

**Operate**, with the character experience leading. The household asks MERLIN for help, reads or hears the checked outcome, and manages available actions without entering a testing dashboard. This is the local combined surface at `/companion/`; [its design reference](../../DESIGN.md) is scoped here. The owner decisions in [PROJECT_CONTEXT.md](../../../../docs/PROJECT_CONTEXT.md) and the [orchestration contract](../../../../docs/ORCHESTRATION.md) supersede the root product file's earlier typed-only scope for this surface.

## Job and sequence

Start with the body and scene clock. Typing or activated speech brings the face forward; a compact status and microphone label remain visible below it. Thinking/searching use their corresponding expression. An actual checked action introduces a body panel, then a reply returns to the face with action panels hidden and up to two independent panel records retained for body mode. More results remain in Activity. Each panel can close independently; timer controls act on their identified timer.

Microphone access starts off and requires the explicit Enable microphone control. Typing focus says “Ready when you are”; actual voice listening has its own state. Typed read-aloud starts on and remembers explicit changes. Test speaker checks local output; microphone permission failures show recovery guidance. Casual waiting activities yield to directed conversation. The clock hides in full-face presentation. Reduced motion retains state and content without casual movement.

## Built direction

The accepted matte-blue character, luminous cyan face/soles, midnight room, and white 5:6 panels are the visual authority. The large landscape stage leads, followed by concise conversation and the input controls. Activity & services opens a secondary column on desktop and follows the conversation on narrow screens. The face occupies the full stage at every width; panels appear only on the body-mode screens. Visible Left/Right labels and accessible action names distinguish duplicate timer labels.

This is an extension of the existing character world with native control typography. No replacement world or concept comp was introduced. The shell is flat, with tonal controls, restrained dividers, and clear cyan focus; visual depth comes from the existing character asset.

## Content and boundaries

The home surface shows actual timer activity, request receipts, service availability, sources, and playback controls when available. Connection setup belongs to the separate application. Lights, oven, and schedules stay explicitly unavailable in this implementation. Spotify supports typing/manual controls here; its metadata is local UI content. No animated panel or simulated Connection Center selection authorizes physical-device behavior.

The old memory/testing interface remains accessible through a disclosure. Ordinary conversation does not expose memory categories, tool names, validation traces, or model counts. Character-load failure leaves a recovery action and the conversation controls available.

## Review and open work

The original integration captures cover desktop, activity, one/two retained panels, disconnected service, and narrow layouts. The initial independent [verdict](../../../../.impeccable/review/companion/verdict.md) is **ship** for its three scored fixes: truthful typed-status wording, independent action-target identity, and minimum (44px) narrow-layout control heights. [Recorded browser checks](../../../../.impeccable/review/companion/qa.json) used isolated storage, scripted providers, real timer persistence, and no microphone.

That review does not verify room microphone/echo behavior, live Spotify playback, physical appliances, runtime animation/audio, production hardware, or background operating-system notifications. Refer to [STATUS.md](../../../../docs/STATUS.md) for functional verification and current limits; do not expand the visual verdict into a claim about those systems.
