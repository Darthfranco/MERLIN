# Floating overlay verification — October 27, 2026

Focused automated command (69 passed, 0 failed):

```sh
node --test assets/merlin-character/viewer/overlays/*.test.mjs assets/merlin-character/viewer/clock-layout.test.mjs assets/merlin-character/viewer/motion.test.mjs assets/merlin-character/viewer/motion-footprints.test.mjs assets/merlin-character/viewer/panels/render.test.mjs
```

Real studio browser checks through visible controls:

- Initial load: zero floating overlay nodes; preview disclosure closed.
- Explicit timer and music preview buttons: two cards; pause/resume changes each synthetic status independently.
- Walking and reverse walking: cards share the clear upper band with the clock.
- Full-face: both retained cards concealed and `aria-hidden`; body return restores them.
- Right panel: both cards concealed when no free anchor remains. Ceiling presentation also conceals both with the clock.
- 1365 px and actual 614 px layouts: both cards readable and clear of the robot, no overflow.
- 390 px layout: retained cards conceal for lack of room; preview status accurately reports zero visible; no horizontal page overflow.
- Clear: zero nodes. Reload: no retained preview cards. No captured page warnings/errors. Viewport override reset afterward.

Screenshots: `desktop-wide.png` (1365 × 900), `desktop.png` (614 × 900), `mobile.png` (390 × 844). These are review evidence, not shipped UI raster assets. All shown content is synthetic preview data.

The single design-detector run used regex fallback because optional HTML/CSS parser modules were unavailable. `detector.json` contains advisory token additions only; it does not establish computed CSS correctness. The independent finish review returned **ship**, including a source-calculated secondary text contrast of 5.43:1 and action-icon contrast of 5.02:1.

This validates the optional presentation layer. No live timer, Spotify playback, companion event integration, physical device, or target-device performance claim is made.
