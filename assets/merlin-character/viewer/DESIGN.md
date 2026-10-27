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
- A separate local preview with honest boundaries around unconnected services.

## Colors

Action blue provides the only application accent; the midnight scene and luminous character details belong to the authored asset.

- **Primary:** action blue marks Play animation, Show on screen, links, and secondary control text. The darker hover tone and pale action fill distinguish interaction states.
- **Neutral:** dark ink carries headings and fields; muted ink carries captions and help. White fields, pale page fill, and cool borders separate controls without cards or ornamental backgrounds.
- **Stage:** the dark backdrop covers loading, while the runtime uses the scene-midnight color for its background and fog. Pale stage messages remain legible over the dark canvas; failed loading uses a solid dark overlay.
- **State:** disabled controls use the muted disabled pair. Motion and content outcomes are written in text, so color does not carry their meaning alone.

## Typography

Use the native system stack for the interface and screen-message textures. The compact headline identifies the tool; section titles distinguish animation selection from screen editing. Labels remain visible above their fields. The code disclosure uses the monospace stack.

Paragraphs use a comfortable line height (1.5); captions and help stop at a readable measure (72ch). The headline reduces to (1.15rem) at the narrow layout and wraps within (16ch). Motion status uses tabular numerals. Screen-message text is painted into a texture and fitted to its available bounds; it is not browser-selectable interface text.

## Layout

The centered page is capped at (1440px), with desktop outer padding of (24px 28px 40px). Its header pairs the title with a direct Blender-file download. The main grid places the flexible stage at left and a (300px) control rail at right, with the column spacing token between them. The preview stays sticky (24px from the top) while the control rail can extend below it.

The stage always uses a (4:3) aspect ratio and the exported orthographic camera. Playback status and Pause/Resume and Return to ready sit immediately below it, followed by the preview-scope caption. The control rail presents Animation, Screen content, then an expandable code example. Form sections use spacing and a single border instead of separate raised cards.

At (960px), page padding and the column gap reduce to (20px), and the rail narrows to (270px). At (720px), the stage and controls stack, the preview stops being sticky, and the two forms initially share a two-column row. At (480px), the forms stack into one column. Playback wraps and its status takes a full row at the smallest width. Narrow page padding is (18px 16px 32px). Above (1600px), the page's top padding increases to (32px).

## Elevation & Depth

The HTML interface is flat: no card shadows or decorative motion. White controls, cool borders, and space establish groups. The 3D scene owns depth through the authored geometry, runtime shadows, matte floor, and restrained bloom. Its lighting is an approximation, not a pixel match to Cycles. Do not compensate for a runtime lighting difference by changing the accepted Blender proportions or material direction.

## Shapes

Controls have gently rounded corners and visible one-pixel borders. The stage uses the larger radius, reducing to the small-stage radius in the stacked layout, and clips the renderer to its bounds. Buttons, selects, image selection, and the disclosure summary have minimum interaction height (44px). Textareas resize vertically and keep a minimum height (88px).

## Components

- **Primary buttons:** full-width blue actions beneath each form. Hover darkens the fill. Secondary playback and content actions remain white with blue text and a border; their hover uses the pale action fill. Disabled controls remain visibly unavailable during loading or failure.
- **Focus:** buttons, links, and the disclosure show a blue outline (3px, offset 3px). Fields use an outline (2px, offset 2px). The file-selection label receives focus styling through its native file input.
- **Fields:** full-width labeled selects, title input, and message textarea. The animation selector groups Body, Screens, Full face, and Casual destinations. Selecting a destination alone does not start it; Play animation does. Screen content has a separate target selector and Show on screen action.
- **Image selection:** a styled label contains the real file input. PNG, JPEG, and WebP images remain in browser memory; no upload or file persistence occurs. Validation feedback appears beside the editor.
- **Stage and status:** loading and failure overlays occupy the stage and retain a retry action. The canvas has an accessible name; motion and content messages use status regions. The canvas does not expose the character's internal scene as an accessible DOM.
- **Playback:** routes retain the latest requested destination, pass through shared ready/full-face poses, and report transition or cycle-completion waits. Pause freezes both character motion and animated screen content. Reduced-motion preference starts paused; an explicit Play action resumes. The authored transitions are the animation language; other loop interruptions use a short crossfade (180ms).
- **Editable screens:** the two white portrait panels and the camera viewfinder accept text, a local image, or a canvas/video source through the API. Texture content stays attached to panel fragments during dismissal. Textures are visual content, not embedded clickable HTML. Reloading restores bundled synthetic content; editor changes do not rewrite the Blender source.
- **Code disclosure:** a native details/summary keeps integration examples below the ordinary controls. Its pale-blue code block scrolls horizontally within its own bounds. It links to the local [API notes](README.md).

## Do's and Don'ts

- **Do** preserve the original character proportions, matte materials, pale cyan display detail, and 4:3 composition.
- **Do** retain labeled native controls, visible keyboard focus, textual status, and explicit playback control.
- **Do** keep screen editing separate from animation selection and preserve content on the correct surface and fragments.
- **Do** label the browser lighting as an approximation and use Blender as the visual reference.
- **Don't** treat camera, searching, or music gestures as proof of live camera, search, or music integration.
- **Don't** turn a textured screen into a claim of clickable DOM, persisted content, or uploaded images.
- **Don't** expand this local preview into a product-platform decision or claim tested production-device performance.
- **Don't** replace the original authored asset with stock or generated substitute artwork. The six Blender state stills carry embedded provenance; owner reference screenshots are not redistributed.
