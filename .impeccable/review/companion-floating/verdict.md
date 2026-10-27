# Floating companion activities — October 27, 2026

Disposition: **ship** for the reviewed visual scope.

An independent read-only review inspected the desktop body/face, mobile body/face, mobile overflow, and desktop mixed timer/music face captures in one bounded pass. The floating cards remain readable and clear of MERLIN; the compact face rail sits below the eyes and mouth, and longer mobile lists stay within the corner and scroll. No material visual corrections were requested. The primary agent also inspected the desktop and mobile captures.

The code review identified a separate retained-music lifecycle issue: hidden physical music bindings could miss playback refreshes or disconnects while floating cards were active. The implementation reconciles those logical records from accepted local Spotify snapshots; focused regression tests cover restoring the updated physical card and disconnected state. This correction does not change the reviewed layout.

The captures use an isolated temporary store with real persisted synthetic timers and a scripted Spotify snapshot. They do not establish real account playback, microphone capture, physical speaker quality, production hardware performance, or operating-system alarms. See `qa.json` for browser behavior and `docs/STATUS.md` for automated checks and limitations.
