---
name: MERLIN screen panels
description: Seven quiet, readable 2D screens inside MERLIN's existing robot world.
colors:
  paper: "#ffffff"
  ink: "#16334b"
  muted: "#546d7f"
  blue: "#246ca7"
  ice: "#eaf5fc"
  cyan: "#8bd9f2"
  line: "#dae7ef"
  quiet: "#f3f7fa"
  green: "#27715c"
  green-bg: "#eaf5f0"
  amber: "#a65224"
  amber-bg: "#fff0e5"
  gallery-line: "#d7e4ec"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  gallery-heading:
    fontSize: "36px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.035em"
  gallery-body:
    fontSize: "16px"
    lineHeight: 1.6
  gallery-label:
    fontSize: "13px"
    fontWeight: 600
  canvas-countdown:
    fontSize: "112px"
    fontWeight: 550
  canvas-header:
    fontSize: "32px"
    fontWeight: 600
  canvas-action:
    fontSize: "31px"
    fontWeight: 600
rounded:
  field: "8px"
  gallery-action: "9px"
  gallery-tile: "16px"
  gallery-detail: "20px"
  canvas-action: "24px"
  canvas-art: "40px"
spacing:
  gallery-column: "32px"
  gallery-row: "40px"
  desktop-gutter: "64px"
  mobile-gutter: "24px"
  canvas-inset: "76px"
components:
  canvas-primary:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.paper}"
    rounded: "{rounded.canvas-action}"
    height: "90px"
    width: "748px"
  gallery-field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "10px 12px"
    width: "100%"
---

# Design System: MERLIN screen panels

## Overview

**Creative North Star: "A little help, at a glance."**

This scoped guide records the implemented [renderer](render.js), [gallery](index.html), and [gallery styles](panels.css). It extends the existing [character studio](../DESIGN.md): the white screens belong beside MERLIN's matte blue body, dark face, and cyan lighting. Keep the accepted character geometry, materials, camera composition, and authored panel motions intact.

The seven designs are countdown timer, lights, oven, music, schedule confirmation, routine confirmation, and routine detail. The owner clarified countdown only; a clock is outside this collection. Each screen gives a prominent useful state, a little context, and the few controls that matter. The gallery is an inspection surface; the panel itself is the reusable artifact.

Desktop/mobile collection, desktop/mobile routine detail, and the right panel on the actual robot were visually inspected. The independent finish review returned **ship**. These checks concern presentation; the previews do not establish live device or service behavior.

## Colors

Use navy ink on white paper for the primary content. Muted blue-grey carries supporting text and inactive states. Blue marks actions, countdown progress, and active lights; ice and cyan connect those details to the character. The footer's three small blue/cyan bars repeat this connection without adding a second identity.

Green is reserved for confirmed/simulated success wording and checks. Amber identifies the active oven graphic; it is not proof that a target temperature has been reached. Always accompany color with text or a recognizable state. The gallery sits on the quiet pale background with its own subtle divider color; retain the distinction between gallery and canvas line tokens.

## Typography

Use the native system stack throughout. Canvas values in the frontmatter are **logical drawing units on a 900 × 1080 canvas**, not rendered CSS font sizes. The painter scales the entire design to the output dimensions; the gallery then scales the canvas to its available width.

Nominal canvas hierarchy: countdown (112), schedule time (101), on/off (90), routine title (61), screen heading (32), actions and routine steps (31), and footer (25). Text is measured, reduced to fit, then ellipsized when necessary; the helper's minimum is (22 logical units). Preserve the hierarchy and the practical labels before adding detail.

Gallery headings use the extracted heading role, reducing to (29px) below the tablet breakpoint and (28px) on the narrowest layout. Detail headings are (32px), reducing to (28px). Ordinary gallery copy remains compact and readable with generous line height; preview explanations use a limited measure (48ch).

## Layout

Both robot panels are **5:6 portrait**. Author at **900 × 1080** and preserve that ratio for textures and exports. The camera viewfinder is a separate surface. Canvas content uses the horizontal inset token, a compact top-left icon/header, a central visual or status, an action zone beginning at logical (y=839), and the footer divider at (y=975). White space is intentional.

The gallery is centered with a maximum width of (1520px). Its collection uses three columns normally, four above (1500px), two at (760px) and below, and one at (440px) and below. At (1000px), desktop gutters reduce to (32px); below (760px), they use the mobile gutter token. Detail view pairs a panel up to (540px) wide with a control column up to (420px), then stacks below (760px) with a panel cap of (460px).

Painted control rectangles use logical canvas coordinates. The gallery maps those coordinates to percentage-positioned HTML buttons with a **minimum CSS target of 44 × 44px**. Preserve this minimum even when the painted button becomes smaller on a phone. Inputs and ordinary gallery actions have a minimum height of (46px). The overview tiles open detail view; their painted controls do not execute individually.

## Elevation & Depth

Panel graphics stay flat. The gallery gives the artifacts a soft ambient lift: tiles use `0 6px 24px #16334b09`, hover uses `0 12px 30px #16334b14`, and the large detail uses `0 14px 48px #16334b10`. Tile hover moves upward only (3px), with a short (0.2s) transition. Reduced-motion preference removes these transitions and movement.

Inside the robot scene, depth and lighting come from the existing model and renderer. A textured panel can appear dimmer under scene shading. Preserve the authored world rather than changing character proportions or materials to compensate.

## Shapes

Use clean rounded forms and restrained outline icons. Gallery fields/actions are gently rounded; the larger canvas action and artwork radii are logical values and scale with the texture. The timer ring, playback disc, circular status checks, and soft device-icon tiles provide simple, recognizable silhouettes. Avoid adding ornamental frames inside the physical panel.

## Components

- **Timer:** a progress ring frames the remaining duration. Pause/resume and cancel stay together; completion or cancellation replaces them with Start again. It shows a countdown, never a clock.
- **Device state:** name, large device icon, explicit On/Off, one toggle. Pending, disconnected, failed, or unknown states replace the action surface with an honest message and expose no action targets.
- **Music:** a locally drawn record supplies the graphic, with track/artist, three transport controls, progress, and output device. Empty and disconnected states stay simple. Synthetic preview metadata does not imply account playback.
- **Schedule confirmation:** success marker, prominent time, recurrence, action/target, and a visible time-zone footer. Preserve one-time versus recurring meaning and the supplied time zone.
- **Routine:** artwork, name, trigger or saved/running/completed status, up to two numbered steps, an overflow count, and the appropriate View/Run action. The generated cartoon is selected by `artKey`; missing art gets a generic local sparkle icon. Saving and viewing remain distinct from running.
- **Focus and access:** gallery links, buttons, and fields have visible keyboard focus (3px outline, 5px offset). Canvas action overlays use an inset cyan-blue focus ring (4px). Keep descriptive button labels, the panel's text alternative, state announcements, and focus restoration when moving between collection/detail views.
- **Export and studio:** PNG export uses the same painter. The studio uses the same canvas on the authored left/right surfaces and fragments. Texture controls are visual only; the gallery supplies the actual HTML interaction layer. Neither surface sends live device commands or saves household routines/schedules.

## Do's and Don'ts

- **Do** preserve the existing robot identity and the seven simple portrait designs.
- **Do** keep the main state large, supporting copy brief, and one obvious primary action where appropriate.
- **Do** distinguish logical canvas units from CSS pixels and maintain minimum touch targets.
- **Do** retain explicit preview scope, missing/unknown states, readable focus, and reduced-motion behavior.
- **Do** use original simple cartoon routine art with its provenance; Tea time is a synthetic example.
- **Don't** change the character's geometry, lighting direction, or materials as part of panel styling.
- **Don't** turn the countdown into a clock or turn a confirmation into an unrequested setup form.
- **Don't** imply that a displayed result proves a live device action, persisted schedule, running routine, or audible playback.
- **Don't** bake personal household data into public artwork or exported textures.
