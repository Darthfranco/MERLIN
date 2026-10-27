---
name: MERLIN at home
description: Character-led local home assistant with a quiet midnight control surface.
colors:
  night: "#081326"
  surface: "#101f34"
  ink: "#e2f5ff"
  soft: "#a9c5d8"
  line: "#31475c"
  cyan: "#8bd9f2"
  action: "#b4e8fb"
  dark-ink: "#12334b"
  control-hover: "#1d344a"
  action-hover: "#d0f1fd"
  panel: "#ffffff"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  reply:
    fontSize: "clamp(18px, 2.2vw, 24px)"
    lineHeight: 1.45
  wordmark:
    fontSize: "18px"
    fontWeight: 700
    letterSpacing: "0.12em"
  heading:
    fontSize: "24px"
  section:
    fontSize: "16px"
    fontWeight: 600
  status:
    fontSize: "13px"
  support:
    fontSize: "12px"
    lineHeight: 1.5
  countdown:
    fontSize: "25px"
rounded:
  field: "8px"
  control: "10px"
  panel: "12px"
  stage: "16px"
spacing:
  tight: "8px"
  small: "12px"
  control: "16px"
  section: "24px"
  page: "32px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-secondary-hover:
    backgroundColor: "{colors.control-hover}"
  text-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "14px 16px"
  retained-panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.panel}"
---

# Design System: MERLIN at home

## Overview

**Creative North Star: "MERLIN at home"**

This scoped reference captures the implemented [companion surface](index.html) and [stylesheet](companion.css). The rounded matte-blue character, luminous cyan face, midnight room, and white action panels carry its identity. Familiar native controls support the character without becoming the main attraction.

The authority for this extension is the owner's combined-character direction in [PROJECT_CONTEXT.md](../../docs/PROJECT_CONTEXT.md) and [ORCHESTRATION.md](../../docs/ORCHESTRATION.md). Root `PRODUCT.md` and `DESIGN.md` describe the earlier utility prototype; this file does not replace them or choose production hardware. Composition and task flow are recorded in the [surface brief](.impeccable/surfaces/index-html.md).

**Key Characteristics:**

- A large character presentation, with compact conversational text and controls.
- Midnight surfaces, pale cyan emphasis, and white retained action panels.
- Visible microphone state and textual service outcomes.
- Independent left and right action content through face/body changes.

## Colors

The shell uses a dark blue neutral range and one pale cyan accent family. Frontmatter records the actual shell colors; the 3D scene and panel painters retain their own established materials and palettes.

### Primary

- **Cyan** identifies active status, links, keyboard focus, caret, selection, and the three-bar brand detail.
- **Action** fills Send and the enabled microphone control; **dark ink** keeps their labels legible.
- **Action hover** lightens the primary control without adding movement.

### Neutral

- **Night** is the page and stage fallback; **surface** distinguishes fields and ordinary buttons.
- **Ink** carries primary text; **soft** carries connection information, help, and secondary labels.
- **Line** separates controls, timer rows, services, and the activity area.
- **Panel** is the white canvas backing shared with the character's action screens.
- **Control hover** supplies restrained tonal feedback on secondary buttons.

State names remain visible. Color alone does not establish listening, completion, availability, or failure.

## Typography

The shell uses the native system stack throughout. Replies are the largest ordinary interface text and preserve line breaks within a centered readable measure (68ch). The wordmark is compact, bold, and letter-spaced; section and supporting labels stay subordinate.

Countdowns use tabular numerals. At the narrow breakpoint, replies become (19px), the wordmark becomes (15px), and activity countdowns become (24px). The shared scene clock has its own container-relative scale in [scene-clock.css](../../assets/merlin-character/viewer/scene-clock.css). The panel painter owns type inside the 5:6 canvases; do not replace it with shell typography.

## Layout

The main container is centered at a maximum width (1600px). The desktop masthead and main area use page spacing horizontally. The stage preserves a landscape ratio (4:3), fitting its width to the available viewport height; the conversation is capped at (880px). The activity area is hidden initially and opens as a secondary right column (320px), with a vertical divider and its own scroll region.

With one retained panel, the scene occupies (64%) and the panel (34%); the visual order follows its left/right identity. With two, the face occupies (48%) between two panels of (24%) each. Panel canvases retain their (5:6) ratio.

At (1000px) and below, page padding and the activity column tighten. At (720px) and below, activity follows the conversation, the input and Send share a row, and the microphone button takes a full row. A single panel stays beside the face; two panels move beneath the face in equal columns. Secondary buttons and the disclosure summary have a minimum height (44px) on this narrow layout. This responsive browser composition is not a final device-platform decision.

## Elevation & Depth

The shell is flat: tonal surfaces and single-pixel dividers provide separation, with no CSS card shadows or decorative gradients. Depth belongs to the rendered character, room, and luminous face/soles. The inherited scene clock uses a small text shadow for legibility over the room.

## Shapes

The character's rounded silhouette is the dominant shape. Shell controls use the control radius; the stage uses the largest radius, reduced to the panel radius on mobile. Retained white panels use the panel radius and clip their canvas. Service rows and timer lists use straight dividers rather than separate cards.

## Components

### Character and retained panels

Body presentation introduces actions; face presentation supports conversation while retaining independent action canvases. Panels reuse the actual shared painter, with separate text descriptions for assistive technology. The clock is hidden during full-face presentation. Authored routes normally animate state changes; urgent conversation takes priority. Reduced motion uses the appropriate static state and suppresses casual movement. Motion and timing remain governed by the orchestration contract.

### Composer and microphone

The single-line request field, Send button, and explicit microphone toggle form the primary control group. Microphone activation is visibly pressed and labeled. Typed focus uses “Ready when you are”; it must not imply audio capture while “Microphone off” is shown. Typed read-aloud is a separate checkbox.

### Status, replies, and recovery

A compact state line keeps presentation and microphone state readable together. Replies use a polite live region; source links appear below the answer. Notices use warm text and concrete recovery wording. Character loading and failure states stay inside the stage, including a Reload character button; typing and voice controls remain available.

### Action controls

Every retained panel has a visible side and label. Timer Cancel/Dismiss accessible names include its side and timer label; Close names its side. These controls are DOM buttons below the stage, distinct from the drawn panel content. Closing one panel preserves the other.

### Activity and services

The expandable activity area contains real timer rows, service availability, current-request receipts, and a privacy/testing disclosure. Timer rows expose countdown, timing metadata, and Cancel/Dismiss. Spotify reveals device/playback controls when available; lights and oven remain “Not connected” and schedules “Not available yet.” Connection setup is outside this home surface.

### Shared interaction treatment

Keyboard focus uses a cyan outline (3px) with an offset (3px) on buttons, fields, links, selects, and disclosure summaries. Disabled buttons reduce opacity and lose the pointer cursor. Hover changes surface tone. Selection, caret, and scrollbars follow the same palette. Browser audio controls appear when a manual playback fallback is needed.

## Do's and Don'ts

- **Do** preserve the accepted character proportions, matte blue materials, cyan lighting, and midnight scene.
- **Do** retain independent panel identity and readable controls across face/body and responsive layouts.
- **Do** keep microphone state explicit and typed readiness distinct from voice listening.
- **Do** show actual availability and checked action results with text.
- **Do** preserve visible focus, narrow-layout touch targets, and reduced-motion behavior.
- **Don't** add account setup, pairing, or provider authorization fields to this surface.
- **Don't** treat a panel animation or a simulated connection as proof that a device action succeeded.
- **Don't** copy the older light utility palette over this scoped character surface.

The final [visual verdict](../../.impeccable/review/companion/verdict.md) is **ship** at the three-fix scope: truthful typed status, distinguishable action controls, and mobile touch targets. Still-image review does not establish runtime motion, audio, or live-provider behavior.
