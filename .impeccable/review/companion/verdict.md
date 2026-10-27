## verdict

1. **Resolved — microphone-status wording.** `face-timer.png`, `face-two-timers.png`, and `mobile.png` now show “Ready when you are” alongside “Microphone off” during typed focus. Source distinguishes typed readiness from the voice-listening status.
2. **Resolved — independent action target identity.** `face-two-timers.png` visibly distinguishes “Left · timer” and “Right · timer”; the mobile groups retain those side labels. Source gives each timer Cancel/Dismiss button an accessible name containing its side and timer label.
3. **Resolved — mobile touch targets.** `mobile.png` and `mobile-activity.png` show enlarged, non-overlapping panel, state, timer, and activity-close controls. The narrow-layout CSS explicitly applies a 44px minimum height to every control named in the finding.

All seven recaptures remain valid. No regression from this fix batch is visible in the reviewed evidence.

## remaining

Clear. This ship verdict covers the three scored fixes; it does not establish runtime animation, audio, network, or live-provider behavior.

disposition: ship
