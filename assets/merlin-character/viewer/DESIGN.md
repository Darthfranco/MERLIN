---
name: MERLIN character studio
description: A local utility for inspecting the authored MERLIN character and editing its screen textures.
colors:
  action-blue: "#185c9e"
  action-hover: "#104778"
  action-soft: "#eaf2f9"
  focus-blue: "#1264ac"
  ink: "#172a3b"
  muted-ink: "#4e6070"
  page: "#f4f6f8"
  surface: "#ffffff"
  border: "#ccd5dd"
  input-border: "#8b9eae"
  disabled-surface: "#e3e8ed"
  disabled-ink: "#526373"
  stage-backdrop: "#060e1c"
  scene-midnight: "#081326"
  stage-message: "#d4ecff"
  stage-error: "#081321"
  clock-digits: "#e4f4ff"
  clock-period: "#b9d9ee"
  clock-date: "#bbdbed"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  headline:
    fontSize: "1.4rem"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontSize: "1.05rem"
    lineHeight: 1.3
  label:
    fontSize: "0.86rem"
    fontWeight: 600
  action:
    fontSize: "0.9rem"
    fontWeight: 600
  help:
    fontSize: "0.82rem"
    lineHeight: 1.5
  code:
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace'
    fontSize: "0.75rem"
    lineHeight: 1.65
  clock-time:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(26px, 8.6cqw, 88px)"
    fontWeight: 350
    lineHeight: 1.05
    letterSpacing: "-0.035em"
  clock-period:
    fontSize: "0.2em"
    fontWeight: 550
    letterSpacing: "0.01em"
  clock-date:
    fontSize: "clamp(10px, 1.85cqw, 19px)"
    fontWeight: 450
    lineHeight: 1.35
    letterSpacing: "0.015em"
rounded:
  control: "6px"
  stage: "12px"
  stage-small: "10px"
spacing:
  compact: "8px"
  action-gap: "10px"
  control-top: "14px"
  group: "16px"
  compact-column: "20px"
  section: "24px"
  column: "28px"
components:
  button-primary:
    backgroundColor: "{colors.action-blue}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "9px 13px"
    width: "100%"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.action-blue}"
    rounded: "{rounded.control}"
    padding: "9px 13px"
  button-secondary-hover:
    backgroundColor: "{colors.action-soft}"
  button-disabled:
    backgroundColor: "{colors.disabled-surface}"
    textColor: "{colors.disabled-ink}"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 11px"
    width: "100%"
  stage:
    backgroundColor: "{colors.stage-backdrop}"
    rounded: "{rounded.stage}"
    width: "100%"
  scene-clock:
    textColor: "{colors.clock-digits}"
    typography: "{typography.clock-time}"
  scene-clock-period:
    textColor: "{colors.clock-period}"
    typography: "{typography.clock-period}"
  scene-clock-date:
    textColor: "{colors.clock-date}"
    typography: "{typography.clock-date}"
---

# Design System: MERLIN character studio

## Overview

**Creative North Star: "Inspect the real Blender character."**

This scoped reference records the implemented [character studio](index.html), its [stylesheet](studio.css), and its [runtime](studio.js). It inherits the blue actions, native typography, clear labels, and flat utility surfaces of the root [design system](../../../DESIGN.md). It does not replace that system or choose MERLIN's final application platform.

The authored midnight scene supplies the visual character. MERLIN retains the original rounded proportions, matte/satin blue surfaces, flush dark display, pale cyan face details, and lit feet. The surrounding interface stays compact so the animated character and editable physical screens remain easy to inspect. Blender is the visual lighting reference; the browser's floor, lights, shadows, and bloom approximate it.

**Key Characteristics:**

- Native controls and restrained blue actions on a pale neutral page.
- A fixed landscape stage that preserves the authored camera composition.
- Explicit animation status, playback controls, and editable screen content.
- A large local time and small date that keep clear of the character and pulled panels.
- A separate local preview with honest boundaries around unconnected services.

## Colors

Action blue provides the only application accent; the midnight scene and luminous character details belong to the authored asset.

- **Primary:** action blue marks Play animation, Show on screen, links, and secondary control text. The darker hover tone and pale action fill distinguish interaction states.
- **Neutral:** dark ink carries headings and fields; muted ink carries captions and help. White fields, pale page fill, and cool borders separate controls without cards or ornamental backgrounds.
- **Stage:** the dark backdrop covers loading, while the runtime uses the scene-midnight color for its background and fog. Pale stage messages remain legible over the dark canvas; failed loading uses a solid dark overlay.
- **Clock:** pale cyan digits lead, with separate softer cyan tints for the period and date. These scoped scene colors extend the character's luminous display language without changing the surrounding utility controls.
- **State:** disabled controls use the muted disabled pair. Motion and content outcomes are written in text, so color does not carry their meaning alone.

## Typography

Use the native system stack for the interface and screen-message textures. The compact headline identifies the tool; section titles distinguish animation selection from screen editing. Labels remain visible above their fields. The code disclosure uses the monospace stack.

Paragraphs use a comfortable line height (1.5); captions and help stop at a readable measure (72ch). The headline reduces to (1.15rem) at the narrow layout and wraps within (16ch). Motion status uses tabular numerals. Screen-message text is painted into a texture and fitted to its available bounds; it is not browser-selectable interface text.

The scene clock inherits the native system stack. Its time and date use the fluid `clock-time` and `clock-date` tokens, sized against the stage's inline container rather than the viewport. Those fluid endpoints and the separate cyan tints are intentional additions to this scoped system. Tabular numerals keep time changes steady; the optional locale-specific period sits on the digits' baseline at one fifth of their size. The date sits below with a gap of (0.55em). Both rows remain on one line; no display font is introduced.

## Layout

The centered page is capped at (1440px), with desktop outer padding of (24px 28px 40px). Its header pairs the title with a direct Blender-file download. The main grid places the flexible stage at left and a (300px) control rail at right, with the column spacing token between them. The preview stays sticky (24px from the top) while the control rail can extend below it.

The stage always uses a (4:3) aspect ratio and the exported orthographic camera. Playback status and Pause/Resume, Return to body, and Return to ready sit immediately below it, followed by the preview-scope caption. The control rail presents Animation, MERLIN panels, Screen content, then an expandable code example. Animation includes three secondary dismissal buttons: left and right share a row, with both beneath them. Their 8px gap and existing 44px button height preserve the incumbent control rhythm. Form sections use spacing and a single border instead of separate raised cards.

At (960px), page padding and the column gap reduce to (20px), and the rail narrows to (270px). At (720px), the stage and controls stack, the preview stops being sticky, and the two forms initially share a two-column row. At (480px), the forms stack into one column. Playback wraps and its status takes a full row at the smallest width. Narrow page padding is (18px 16px 32px). Above (1600px), the page's top padding increases to (32px).

The clock is a DOM overlay inside the same clipped stage, with a minimum width of (27cqw). It has exactly five resting anchors: upper left, upper middle, upper right, lower left, and lower right. Corner anchors sit inward by (5.5% of the shorter stage dimension); upper middle shares their top inset and centers the measured clock. Placement adds clearance of (1.8% of the shorter stage dimension) around the measured text bounds. The same anchors and proportional sizing apply on desktop and narrow layouts.

## Elevation & Depth

The HTML interface is flat: no card shadows or decorative motion. White controls, cool borders, and space establish groups. The 3D scene owns depth through the authored geometry, runtime shadows, matte floor, and restrained bloom. Its lighting is an approximation, not a pixel match to Cycles. Do not compensate for a runtime lighting difference by changing the accepted Blender proportions or material direction.

The scene clock has only a diffuse text shadow (`0 2px 12px #060e1c66`) to preserve legibility over the midnight scene. It adds no card surface or raised container.

## Shapes

Controls have gently rounded corners and visible one-pixel borders. The stage uses the larger radius, reducing to the small-stage radius in the stacked layout, and clips the renderer to its bounds. Buttons, selects, image selection, and the disclosure summary have minimum interaction height (44px). Textareas resize vertically and keep a minimum height (88px).

The clock is unboxed, with centered time and date. It has no pointer interaction and does not intercept the stage.

## Components

- **Primary buttons:** full-width blue actions beneath each form. Hover darkens the fill. Secondary playback and content actions remain white with blue text and a border; their hover uses the pale action fill. Disabled controls remain visibly unavailable during loading or failure.
- **Focus:** buttons, links, and the disclosure show a blue outline (3px, offset 3px). Fields use an outline (2px, offset 2px). The file-selection label receives focus styling through its native file input.
- **Fields:** full-width labeled selects, title input, and message textarea. The animation selector groups Body, Screens, Full face, and Casual destinations. Selecting a destination alone does not start it; Play animation does. Screen content has a separate target selector and Show on screen action.
- **Image selection:** a styled label contains the real file input. PNG, JPEG, and WebP images remain in browser memory; no upload or file persistence occurs. Validation feedback appears beside the editor.
- **Stage and status:** loading and failure overlays occupy the stage and retain a retry action. The canvas has an accessible name; motion and content messages use status regions. The canvas does not expose the character's internal scene as an accessible DOM.
- **Playback:** routes retain the latest requested destination, pass through shared ready/full-face poses, and report transition or cycle-completion waits. Pause freezes both character motion and animated screen content. Reduced-motion preference starts paused; an explicit Play action resumes. Each walking direction plays one pass and settles into a relaxed held endpoint, without a repeating teleport or automatic reversal. The authored transitions are the animation language; other loop interruptions use a short crossfade (180ms).
- **Context and full face:** full-face gestures remember the originating body activity and panel layout. Return to body restores it; Return to ready explicitly exits to the central ready stance. Deep thought stays within the current body context, or becomes the thinking face while expanded. Neither entering nor leaving full-face presentation dismisses a panel.
- **Screen dismissal:** choosing the paired layout pulls both screens and seats MERLIN between them. Dismiss left/right preserves the other panel and seated pose; Dismiss both returns to ready. Unavailable sides are disabled. Requests during a transition retain the latest intended arrangement. Editing a visible screen keeps its paired or seated layout; editing a remembered panel from full face restores that same layout.
- **Ceiling screen:** Jump & pull down a large screen uses the existing right surface at landscape proportions. Two secondary Move screen left/right buttons carry it into the portrait layout. Text/code painters reflow; images, canvas/video sources, and portrait designs contain-fit. Content follows the right-to-left mesh handoff, including live sources, without creating another physical texture identity.
- **Editable screens:** the two white portrait panels and the camera viewfinder accept text, a local image, or a canvas/video source through the API. Texture content stays attached to panel fragments during dismissal. Textures are visual content, not embedded clickable HTML. Reloading restores bundled synthetic content; editor changes do not rewrite the Blender source.
- **Code disclosure:** a native details/summary keeps integration examples below the ordinary controls. Its pale-blue code block scrolls horizontally within its own bounds. It links to the local [API notes](README.md).

### Scene clock

The [clock stylesheet](scene-clock.css), [overlay runtime](scene-clock.js), and [placement planner](clock-layout.js) implement a quiet, persistent time-and-date display. It uses the browser's locale and local time zone, shows hours and minutes with a separate period when applicable, and keeps advancing while character playback is paused. A semantic time element and a full localized date/time label expose the display without a repeating live announcement.

**The Clear Slot Rule.** Keep the current resting anchor whenever its measured text bounds remain clear across the planned motion. Replan on motion-route or size changes; do not chase each rendered pose. Precomputed [motion footprints](motion-footprints.json) reserve the full destination loop and the active route segment, including the walk back in the opposite direction, return transitions, and panel dismissal shards. When moving between opposite panels, retain clearance for the old panel through dismissal, then replan at the shared ready pose before the next pull. For the simultaneous paired layout, reserve both screens and the exact directed dismissal route through the remaining seated idle. Playback and clock planning share the same authored transition graph. If all anchors overlap, choose the least-obstructed anchor with a small stability tolerance.

Anchor changes use a quick easing-out movement (320ms, `cubic-bezier(.16, 1, .3, 1)`). Resizing, first placement, and reduced-motion preference place the clock immediately. Visibility uses a short opacity transition (130ms ease-out); reduced motion removes it. Full-face entry, every full-face substate, and the entire exit hide the clock visually and from accessibility APIs. The large ceiling pull, idle/thought, and full conversion into a side panel also hide it because the screen occupies nearly the whole frame; it returns after the body scene is restored. Future full-face clips do not displace a clock that is still visible during an earlier activity.

The scene clock is separate from the existing [panel design system](panels/DESIGN.md) and its countdown timer. It does not alter panel styling or imply installed timers, schedules, or device behavior. Finish review returned **ship**, with no material fixes, against the precisely specified local extension and incumbent midnight scene; no approved concept comp or separate QUALITY BAR applied. Review evidence: [desktop](../../../.impeccable/review/clock/desktop.png), [mobile](../../../.impeccable/review/clock/mobile.png), [left panel](../../../.impeccable/review/clock/desktop-left-panel.png), [right panel](../../../.impeccable/review/clock/desktop-right-panel.png), and [full face](../../../.impeccable/review/clock/full-face.png).

## Do's and Don'ts

- **Do** preserve the original character proportions, matte materials, pale cyan display detail, and 4:3 composition.
- **Do** retain labeled native controls, visible keyboard focus, textual status, and explicit playback control.
- **Do** keep screen editing separate from animation selection and preserve content on the correct surface and fragments.
- **Do** label the browser lighting as an approximation and use Blender as the visual reference.
- **Do** retain a clear clock anchor across the complete planned motion, including reverse walking and panel dismissal, and hide the clock throughout full-face entry, substates, and exit.
- **Do** keep clock movement brief and use immediate placement when reduced motion is requested.
- **Don't** treat camera, searching, or music gestures as proof of live camera, search, or music integration.
- **Don't** turn a textured screen into a claim of clickable DOM, persisted content, or uploaded images.
- **Don't** expand this local preview into a product-platform decision or claim tested production-device performance.
- **Don't** replace the original authored asset with stock or generated substitute artwork. The six Blender state stills carry embedded provenance; owner reference screenshots are not redistributed.

The complete paired pull and simultaneous dismissal temporarily hide time: their full swept paths leave no clear resting anchor. Time returns at the seated or ready endpoint. Selective dismissals keep time visible and replan from the remaining seated pose before another exit.
