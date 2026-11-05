# MERLIN status

Last updated: **November 4, 2026**. One screen on where things stand. The dated history of every change, with how it was checked, is in the [development log](devlog.md).

## The product

- **Home display:** `http://127.0.0.1:3000/companionfull/`. The robot-only screen for a wall or counter iPad: voice starts by itself, and anything that needs a hand is a large button on MERLIN's panels.
- **Connection Center:** `http://127.0.0.1:3000/connections/`.
- **Demo mode:** `npm run demo` adds the labeled, simulated Demo home (three lights, a gym speaker, an oven). `npm start` runs without it.

## Works

- Voice conversation: local "MERLIN" wake word, automatic end of speech, interruptions, follow-ups, and an end after sustained quiet. Speech goes to Muse Voice Transcribe; replies are spoken by local Kokoro (Fenrir).
- MERLIN always answers a request he has accepted. Search answers come in three spoken parts: a prerecorded clip, a short "looking it up" line, then the answer.
- Muse Spark plans and calls tools: web search and page reading, timers, devices, Spotify, routines, memory and camera.
- Memory you can inspect, edit and clear; standing rules checked against every reply and action; routines that run on a phrase. The v2 memory engine can be selected with `MERLIN_MEMORY_ENGINE=v2`.
- Device camera, which always asks first: SAM 3.1 and Muse Spark describe one frame, and only the words are kept.
- Spotify: voice plus one tap. A spoken request shows a Play button; only a person's tap plays it.
- 3D robot with 118 animation clips that follows what the assistant is doing.
- The full automated test suite passes offline (`npm test`, no API key needed).

## Simulated or not verified

- The Demo home is simulated, and labeled as such everywhere it appears.
- The Home Assistant, Hue, Shelly, SwitchBot and Rachio connectors are tested against simulated APIs only, not real hardware.
- Spotify playback has not been tried on a real account.
- Voice has been tested with synthetic audio, not people talking in a real room.

## Next

See [ROADMAP.md](../ROADMAP.md): real-hardware checks, schedules, home cameras, linting and CI, and splitting `src/assistant.js`.

## Developer tools

These help with building and are not part of the product: `/companion/` (the same assistant with typing and an inspector), the memory lab at `/`, the voice lab (`npm run voice`), the character studio and b-roll dashboard (`npm run broll`), and a guide-only Connection Center (`npm run connections`).
