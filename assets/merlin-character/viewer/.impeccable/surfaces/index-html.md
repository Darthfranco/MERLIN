---
version: 1
slug: "index-html"
primary_target: "index.html"
related_targets: ["studio.css","studio.js","screens.js","motion.js","motion-routes.js","scene-clock.js","clock-layout.js","screen-layout.js"]
---

# MERLIN character studio

## Scope and mode

Operate: a separate local browser utility for the owner and developers to inspect the actual Blender/glTF character, choose animation states, and supply content to its three screen surfaces. This surface inherits the established MERLIN utility language; its scoped visual reference is `assets/merlin-character/viewer/DESIGN.md`.

## Job and sequence

Choose a mood or action, press Play animation, inspect the transition, then edit a screen with text or a local image. The primary action is Play animation. The ceiling pull exposes a large programmable screen and two Move screen left/right actions; content retains its aspect and follows the screen to either side. The paired-screen destination pulls both panels and seats MERLIN between them; Dismiss left/right keeps the other screen, while Dismiss both returns to ready. Editing a visible screen preserves its seated arrangement. Pause/Resume, Return to body, and Return to ready remain beside the stage. Full-face excursions restore the previous activity and open panels; Deep thought keeps the current presentation context. An expandable code example leads to the API notes after the ordinary controls.

## Built direction

A large authored midnight stage leads on desktop, with a compact control rail at right. Narrow screens put the stage first and the controls below. The character and its fixed landscape composition carry the expression; native blue utility controls provide a familiar editor. The signature interaction is pulling a physical panel into the scene, changing its content, then retaining that texture across the dismissing fragments. This was a narrowly specified code-led extension, with no replacement visual identity or generated concept comp.

## Content and boundaries

The actual asset supplies paired screens, contextual thinking, reversible full-face excursions, and walking in both directions. Each walk plays once and rests at its endpoint until another action is chosen. Two panel screens and the camera viewfinder accept texture content. Original rounded proportions and matte/satin materials remain; Blender supplies the lighting reference and the browser uses an approximation. Screen editing is local and temporary. The preview is silent; camera, search, and music gestures do not activate services, and textured controls are not clickable DOM. Six original Blender state stills carry embedded provenance; no stock or image-generation assets were introduced.

## Review and open work

The October 27 paired/ceiling-screen finish review returned **ship**, with no material fixes. All eight native browser captures were independently inspected: five desktop views at 1096px and three mobile views at 390px, with a 358 × 268.5px stage. The accepted character identity, editable screen composition, retained pair, selective dismissal, and existing utility layout remain coherent. All 92 focused motion, screen, actual-asset footprint, shared-driver, and companion tests pass against the final 113-clip / 30-state asset. The [review and evidence](../../../../../.impeccable/review/character-screens/review.md) record the exact scope. This does not establish production-device performance or live assistant integration. Connecting events and services, device benchmarking, and browser whistle playback remain outside this preview.

Time remains visible in seated idles and selective dismissals. The complete paired pull and simultaneous dismissal hide it until their clear endpoint, because their swept paths cover all five anchors.
