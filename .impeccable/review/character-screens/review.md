# Character-screen finish review

October 27, 2026. Scope: paired seated screens, independent dismissal, retained body/full-face contexts, and the ceiling screen with left/right docking in the existing local character studio.

**Disposition: ship. Material fixes: none.** The independent finish review inspected all eight native browser captures against the accepted character and scoped utility design. This is a specific extension of the existing interface, without a replacement identity or separate approved concept comp.

MERLIN retains the rounded proportions, matte blue body, flush dark face, cyan facial light, and illuminated soles. The paired panels frame the seated character without crowding it. The large ceiling screen fills the stage while keeping MERLIN visible in the lower foreground. Content maintains its proportions in the large and portrait layouts, and the restored pair retains distinct Ideas/Plans content. The scene clock has clear separation in the visible seated and side layouts and is absent over the ceiling screen.

The desktop control rail preserves the established utility hierarchy. At the native 390px viewport, the 358 × 268.5px stage and stacked controls fit the page without horizontal overflow; playback and dismissal actions remain clear and comfortably sized. The small textured panel details remain part of the scaled 3D preview, not interactive DOM controls.

**Verification:** all **92 focused tests pass** against the final **113-clip / 30-state** asset and its regenerated motion footprints: 45 motion/clock/screen tests, seven actual-asset footprint tests, and 40 shared-driver/companion orchestration tests. Coverage includes all 900 ordered state pairs, selective dismissal, retained face contexts, ceiling content transfer, aspect handling, and clock clearance. Browser interaction checks were performed by the implementing agent; this reviewer independently inspected the captured results. The scoped diff check passes.

## Evidence

- [Desktop ceiling](desktop-ceiling.png): large editable screen with the full character visible.
- [Desktop left](desktop-left.png): carried content in the left portrait layout; clock clear at upper right.
- [Desktop right](desktop-right.png): matching right portrait layout; clock clear at upper left.
- [Desktop pair](desktop-both.png): seated MERLIN between distinct screens, with time in a clear lower slot.
- [Desktop restored pair](desktop-restored-pair.png): the same arrangement and content after the full-face excursion.
- [Mobile pair](mobile-both.png): native narrow layout with both panels and all three dismissal actions.
- [Mobile selective dismissal](mobile-dismiss-left.png): right panel and seated character retained after removing the left.
- [Mobile ceiling](mobile-ceiling.png): landscape content fits and MERLIN remains visible at 390px.

Keep the accepted character, restrained controls, explicit return actions, and context-preserving screen behavior. This review does not establish production-device performance, complete accessibility conformance, or live camera/search/music integration. Browser lighting remains an approximation of the Blender reference.
