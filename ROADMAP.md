# Roadmap and known issues

MERLIN is a hackathon prototype. This is the short, honest list of what still needs work, most important first.

## Not verified yet

- **Real hardware.** The Home Assistant, Philips Hue, Shelly, SwitchBot and Rachio connectors pass tests against simulated device APIs, but none has controlled a real device yet.
- **Real Spotify playback.** The connection and controls are built; playback on a real account and speaker hasn't been checked.
- **A real room.** Wake-word accuracy, echo and conversation timing were tested with synthetic audio, not with people talking in a room.

## Not built yet

- Home cameras and doorbells (e.g. Ring)
- Schedules ("every weekday at 7") and location triggers ("preheat when I'm five minutes away")
- Calendar
- A phone app connected to the home display
- Telling different household members apart (today there is one shared household)

## Code health

- **No linting, formatting or CI.** Hundreds of lines run past 200 characters, including the model prompts. Add Prettier and ESLint, plus a GitHub Actions job that runs `npm test` on every push.
- **`src/assistant.js` does too much.** About 1,000 lines, importing 19 modules. Split it into prompt building, tool routing, and reply checking.
- **The server imports browser code.** `src/assistant.js` imports `public/connections/catalog.js`. Move shared data into `src/shared/` and have both sides import it from there.
- **Too much keyword matching around the model.** The `*-intents.js` files use regular expressions to spot timers, routines, camera, connection and search requests. They break in surprising ways: "speak" matching inside "speakers" once silenced every spoken acknowledgment. Prefer structured model output, keep pattern matching only for safety gates, and test with varied real phrasing.
- **Large binary files in git.** The Blender and GLB files are about 95 MB, and every re-export adds about 50 MB to the history. Move `*.blend`, `*.glb` and `*.mp4` to Git LFS.
