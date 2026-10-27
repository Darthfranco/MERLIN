---
name: MERLIN phone companion
description: A familiar home assistant within a thumb’s reach, in a local phone demo.
colors:
  midnight: "#080f1c"
  outer-night: "#050a12"
  nav-night: "#0c1624"
  sheet-night: "#101c2c"
  raised-navy: "#16283e"
  line: "#25364a"
  ice-cyan: "#8bddf4"
  ice-cyan-hover: "#b3ecfd"
  pale-ink: "#e8f3fc"
  muted-blue: "#98adc4"
  button-ink: "#092133"
  brand-tile: "#f1f6f9"
  connected-mint: "#8fe0cd"
  danger-ink: "#f1aca8"
  danger-fill: "#bd635f"
  receipt-navy: "#102435"
  receipt-line: "#254252"
  selection-navy: "#213b51"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "15px"
    lineHeight: 1.65
  display:
    fontSize: "35px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.035em"
  headline:
    fontSize: "32px"
    fontWeight: 600
    lineHeight: 1.16
    letterSpacing: "-0.035em"
  sheet-title:
    fontSize: "21px"
    fontWeight: 600
    letterSpacing: "-0.025em"
  service-title:
    fontSize: "14px"
    fontWeight: 500
  wordmark:
    fontSize: "20px"
    fontWeight: 650
    letterSpacing: "0.15em"
  navigation:
    fontSize: "11px"
    letterSpacing: "0.015em"
  input:
    fontSize: "16px"
rounded:
  filter: "8px"
  small-button: "9px"
  input: "10px"
  control: "12px"
  receipt: "13px"
  composer: "26px"
  circle: "50%"
spacing:
  icon-gap: "6px"
  compact: "8px"
  control: "12px"
  row: "16px"
  composer-gutter: "18px"
  message-gutter: "22px"
  shell-gutter: "24px"
components:
  button-primary:
    backgroundColor: "{colors.ice-cyan}"
    textColor: "{colors.button-ink}"
    rounded: "{rounded.control}"
    height: "49px"
    width: "100%"
  button-primary-hover:
    backgroundColor: "{colors.ice-cyan-hover}"
  button-disconnect:
    backgroundColor: "#17293e"
    textColor: "#cbdfee"
    rounded: "{rounded.control}"
    height: "49px"
  button-small:
    backgroundColor: "#254660"
    textColor: "#d4f3ff"
    rounded: "{rounded.small-button}"
    padding: "10px 14px"
    height: "44px"
  button-talk:
    backgroundColor: "{colors.ice-cyan}"
    textColor: "#0b2638"
    rounded: "{rounded.circle}"
    size: "76px"
  search-field:
    backgroundColor: "#111f30"
    textColor: "#e9f3fc"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "48px"
  filter-selected:
    backgroundColor: "{colors.selection-navy}"
    textColor: "#d9f4ff"
    rounded: "{rounded.filter}"
    padding: "9px 12px"
    height: "40px"
  receipt:
    backgroundColor: "{colors.receipt-navy}"
    rounded: "{rounded.receipt}"
    padding: "13px 14px"
  brand-tile:
    backgroundColor: "{colors.brand-tile}"
    rounded: "{rounded.control}"
    padding: "9px"
    size: "43px"
  composer:
    backgroundColor: "#111e2e"
    textColor: "{colors.pale-ink}"
    rounded: "{rounded.composer}"
    padding: "6px"
  navigation:
    backgroundColor: "{colors.nav-night}"
    textColor: "#8fa5bd"
    typography: "{typography.navigation}"
---

# Design System: MERLIN phone companion

## Overview

**Creative North Star: "MERLIN within a thumb’s reach"**

The same friendly home assistant moves between a message thread, a familiar face, and a practical settings list. The owner’s pinned direction is clean, simple, futuristic, and comfortable on a phone: midnight blue, the established cyan MERLIN character, generous dark space, and legible native typography. Futuristic character comes from the face, precise fine borders, and restrained light at active controls.

This is a scoped **Operate** surface. The built sources are [index.html](index.html), [styles.css](styles.css), [app.js](app.js), and [face.js](face.js); [docs/PHONE.md](../../docs/PHONE.md) defines the current product boundary. The older root product/design files describe the separate text test harness. This document records the phone implementation without selecting a native framework, changing the iPad interface, or claiming a shared backend. The source contract and existing mobile captures are the design evidence; final reviewer disposition is recorded separately in the phone review folder.

**Key Characteristics:**

- A narrow, persistent three-tab shell: Chat, Talk, Connections.
- Native phone typography over calm midnight surfaces.
- One actual MERLIN face, with readable listening, thinking, and speaking states.
- Recognizable brand marks in light tiles within a settings list.
- Explicit local-demo, microphone, storage, and simulated-action labels.

## Colors

Ice cyan supplies the main interaction accent. Midnight and closely related navy surfaces provide quiet separation; pale text and muted blue supporting copy preserve hierarchy. The frontmatter values are extracted from the CSS, including `--bg`, `--panel-light`, `--line`, `--muted`, and `--cyan`; descriptive token names here do not introduce a second palette.

- **Primary:** ice cyan appears on the active navigation item, the primary connect/preview button, the talk control, caret, focus outline, and small action icons. Primary button hover becomes a paler cyan.
- **Neutral:** midnight is the phone canvas; nav night separates the persistent bottom bar; sheet night separates dialogs; raised navy is used for pending attachments. Pale ink carries main content and muted blue carries subordinate text. Single-pixel blue-gray lines define regions.
- **State:** mint accompanies the check and “Connected · Demo” text. Warm pink marks destructive controls. Warm amber text/surface combinations identify storage warnings. None of these colors replaces a written state.
- **Brand tiles:** each service mark retains its own identity on a light tile. Preserve official shapes and aspect ratios; [LOGOS.md](LOGOS.md) records sources, trademark scope, and plain-label exceptions.

## Typography

The intentional family is `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` throughout. Native rendering makes the phone controls familiar and readable, keeps input behavior comfortable, and avoids an external font request. The futuristic brief does not call for a decorative science-fiction font.

The welcome headline is 35px/1.2 with weight 600 and slightly tightened tracking. Normal page headings are 32px/1.16; Talk uses a smaller 27px headline, detail titles use 30px, and dialog titles use 21px. The MERLIN wordmark uses 20px, weight 650, and 0.15em spacing. This tracking treatment belongs to the wordmark and small assistant identifier, not body copy.

Conversation text is 15px with a 1.65 line height. Most service labels and explanatory content are 13–14px. Navigation is 11px; timestamps, privacy context, microphone state, and connection metadata are 9–11px. Message and memory inputs are 16px. Preserve visible labels or accessible names for every field and control; placeholders are supplementary. Text preserves line breaks, long message text wraps, and file names remain readable in the available width.

## Layout

The shell is one column, full width up to **480px**, `100dvh`, and at least 460px tall. The header and three-column bottom navigation remain outside each view’s scroll region. Chat keeps its composer outside the scrolling history. Talk and Connections scroll their own content when height is constrained. Safe-area insets pad the top header, bottom navigation, and sheet content. The viewport opts into content resize for the software keyboard.

Typical horizontal insets are 18px for the composer, 22px for messages, 23px for Talk/Connections, 24px for the header/sheets, and 27px for the welcome area. These are observed component values, not a fabricated universal spacing scale. Service rows use 12px gaps and 16px vertical padding; major groups have about 24–30px separation.

At **600px and wider**, the same phone shell sits in a dark radial backdrop with 24px outer padding, a 30px radius, a border, and ambient shadow. Its height becomes `calc(100dvh - 48px)`, bounded by 550–960px. This is a desktop preview of the phone layout, not a tablet redesign. Dialogs become centered with 22px corners.

At **740px height and below**, the header, welcome composition, Talk face stage, and captions tighten. At **350px width and below**, side padding, headings, service labels, filters, and action gaps reduce. Filters and pending attachments can scroll horizontally within their regions; ordinary screens remain a single column.

## Elevation & Depth

Most depth comes from tonal layering and fine borders. The greeting, conversation, and service lists avoid heavy shadows. Light sits around the voice control and face presence; the desktop surround gives the phone shell a distinct boundary. There is no backdrop blur or glass effect.

The exact shadow vocabulary is:

- Talk button: `0 9px 24px #01071180`.
- Settings/preview sheet: `0 -10px 60px #0008`, with `#020812c9` behind the modal.
- Toast: `0 10px 30px #0006`.
- Desktop phone shell: `0 25px 90px #0008`.

## Shapes

The form language follows MERLIN’s rounded face without repeating it on every container. Common controls and brand tiles use 12px corners; suggestions and action receipts use 13px; filters use 8px. The composer is a 26px capsule. Icon and voice controls are circular. The user-message bubble has `18px 18px 5px 18px` corners, while assistant replies sit openly in the thread.

Phone dialogs have `24px 24px 0 0` corners and meet the lower edge. The face view keeps the existing 4:3 asset and its rounded head silhouette, with no body. The canvas and fallback are absolutely positioned within the flex stage at 85% width and 100% height, inset 7.5% from the left, with `object-fit: contain`; this preserves the authored aspect within short layouts without pushing feedback down. The renderer excludes the full-frame backing mesh so the existing silhouette sits directly on the navy scene. Do not crop or stretch brand marks to fill tiles; `object-fit: contain` preserves them.

## Components

**Buttons and focus.** Primary actions use pale cyan with dark text, 12px corners, and a 49px minimum height. Disconnect is an outlined navy secondary action. General icon controls are 44 × 44px; secondary voice controls are 46 × 46px, the main talk button is 76 × 76px, and bottom-nav targets are at least 51px high. The current send button is 40 × 40px with 2px surrounding margin; filter buttons are at least 40px high and pending-file remove controls are 36 × 36px. These describe actual sizes rather than claiming every target meets one blanket dimension.

Keyboard focus is a 2px cyan outline with a 4px offset on buttons, links, fields, and disclosure summaries. The composer’s field uses the parent border-color change; search has its visible focus-within border. Disabled controls remain visible with muted styling. Native dialog behavior constrains focus; close returns it to the triggering control, and service-detail back focuses the search field.

**Chat and composer.** The thread identifies speaker, time, and Talk-origin messages. User bubbles align right and cap at 88% width; assistant text aligns left with a 94% cap. Receipts have an icon, title, detail, and explicit “Simulated action” label. The composer holds Attach, a growing text field capped at 120px, and Send; pending attachments are removable above it. Sent attachments become local download links; supported image types show bounded previews. A polite log announces conversation additions, and a separate status announces thinking.

**Connections and brand tiles.** Connections is a settings list with search, All/Connected/Accounts/Home filters, section counts, and full-row navigation. Rows are at least 79px high with a 43px light logo tile, service name, setup/category or demo status, and a chevron. Detail pages use a 72px mark, concise description, a connect/disconnect action, demo boundary, and progressively disclosed setup requirements/limitations. Restricted real-provider access is called out above the action. Connect changes only the demo selection; a brand mark is not a verified-service badge.

**Settings sheets.** Memory and local-data controls live in a native bottom-sheet dialog capped at 85dvh. Its header remains visible, with the body scrollable. Memory can be added, edited, or removed. Clear chat and delete-all remain separate actions; destructive confirmation offers “Keep my data” before Delete. A persistent storage alert and concise toast report failures or outcomes without replacing the underlying screen.

**Talk and motion.** A centered face stage, state label, response caption, and explicit microphone label communicate idle/listening/thinking/speaking. The existing authored face geometry and clips are reused. A 1.6-second pulse marks listening; a four-second linear ring rotation marks thinking; the speaking ring grows to 1.07 scale and the existing seven mouth bars animate. Mouth movement is a speaking-state illustration, not a claim of phoneme alignment. Text preview visibly keeps the microphone off; actual input is available only when on-device recognition is supported.

Message arrival uses 250ms and `cubic-bezier(.16,1,.3,1)`; the thinking ellipsis breathes over one second. Suggestion and talk hover transitions are 200ms, with a restrained 1.03 scale on the talk button. `prefers-reduced-motion: reduce` removes CSS animations, transitions, and smooth scrolling. The face renderer also holds a static appropriate pose, cancels its animation loop, and respects preference changes. Hidden Talk screens and hidden documents pause rendering; fallback imagery keeps the same character identity when WebGL is unavailable.

## Do's and Don'ts

### Do

- Do preserve the three equal bottom destinations and keep service setup in Connections.
- Do reuse the existing MERLIN face, native font stack, midnight background, and cyan active states.
- Do pair color and animation with written connection, microphone, processing, and storage states.
- Do keep brand marks recognizable on light tiles and retain their documented provenance.
- Do make Chat and Talk read as one conversation with one local memory.
- Do retain reduced-motion, visible keyboard focus, safe areas, and short-screen scrolling.

### Don't

- Don't imply live account access, actual device execution, or iPad synchronization in this demo.
- Don't replace the existing face with a new mascot, add its body to Talk, or turn settings into another chat mode.
- Don't add decorative instrumentation that competes with messages or controls.
- Don't use brand logos as proof of endorsement or tested hardware support.
- Don't apply this phone document to the separate root text harness or home-display interface.
