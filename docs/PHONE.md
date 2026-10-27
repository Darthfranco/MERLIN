# MERLIN phone companion

The owner requested this separate phone experience on October 27, 2026: text chat with attachments, a full-face Talk screen using the existing MERLIN character, and a recognizable branded Connections menu. The iPad/home-display surface is being developed separately. This local browser implementation is a prototype choice, **not a final native framework, platform, hosting, or shared-backend decision**.

## Run

```sh
npm run phone
```

Open `http://127.0.0.1:3003` on this computer. `PHONE_PORT` can choose another loopback port. `npm run dev:phone` restarts the static server when it changes. The interface is designed for phone viewports and safe areas; desktop shows the same compact companion. The loopback server is intentionally not exposed on the local network, so it is not directly reachable from another physical phone. No credentials, `.env`, Meta calls, OAuth, or iPad process are needed.

## What works

- **Chat:** responsive messages, original MERLIN courtesy, useful suggested requests, simulated action receipts, file attachment selection, image previews, and local downloads. Text and files render as data; attachment contents are not read or interpreted by the mock engine.
- **Talk:** the actual authored full-face geometry and idle/blink/thinking clips from `merlin-states.glb`, plus mouth-bar motion while replying. The body is always excluded. Text and Talk use the same history, preferences, connection state, and deterministic demo engine. A typed voice preview and one-tap sample work without microphone access. Stop, screen changes, page hiding, and settings release voice activity.
- **On-device voice:** when the browser exposes local SpeechRecognition and its English language pack is already available, an explicit tap starts local recognition. No cloud-recognition fallback or language-pack download is made. The microphone has a visible active state and a 15-second cap. Other browsers explain the limitation and offer the preview. Optional spoken replies use a voice marked `localService` by the browser. This is a device-voice demo, not the project's Fenrir deployment. Physical microphone recognition and speaker quality require owner testing on a supported device.
- **Connections:** all 45 existing [Connection Center](CONNECTIONS.md) entries, plus nine user-account services: Spotify, Apple Music, Google Calendar, Outlook Calendar, Gmail, Outlook email, Google Drive, Dropbox, and Notion. Search names, companies, categories, and aliases; filter connected/accounts/home; review existing setup requirements, steps, limits, and provider references. Connect/disconnect updates only browser state. Fresh demos include simulated Hue and Google Calendar connections; a full delete leaves none connected.
- **Local memory:** a shared text/voice preference list, conversational remember/recall/forget, direct add/edit/delete, separate clear-chat and delete-all controls, and cross-tab state refresh. No personal memories are preinstalled. Only explicitly supported simple preference phrases are learned. Rules, routines, scheduling, web search, arbitrary reasoning, and real service commands remain unavailable and are acknowledged honestly.

Every action receipt is labeled simulated. Timer/reminder receipts do not run a scheduler or promise alerts. Calendar events are explicitly fictional. Spotify voice control and alarms are unavailable; no Spotify account, tracks, playlists, or listening metadata are fetched or learned. Brand presence indicates a catalog/demo connection, not verified hardware compatibility or live API support.

## Storage and privacy

`merlin-phone-demo-v1` in localStorage contains chat, attachment metadata, preferences, and simulated connections. Sent file bytes are held in the browser's `merlin-phone-attachments-v1` IndexedDB store. Unsent selections remain in tab memory. Limits are eight files per message, 10 MB per file, and 50 MB of sent/pending attachments per demo. Files survive reload on the same browser/origin; changing port, browser, or device does not sync them.

History is not silently truncated. Storage failures are shown; an in-memory session can continue without claiming reload persistence. Delete-all clears local messages, memories, files, pending voice work, and connections. Forget/edit removes old source/recall copies from history. Clear-chat removes messages/files and retains preferences/connections. Clearing this origin's site data in browser settings is the recovery if browser storage itself cannot be deleted. No chat, files, preferences, or credentials are written into the repository.

The Node server serves only the phone assets, the existing connection catalog, and required character/Three.js files, with loopback host/origin checks, no write APIs, path/symlink protections, and a local-only content security policy. External setup guides open only when chosen by the user. No runtime fonts or logos are loaded from a third party.

## Source and contribution

Original phone UI, deterministic demo state, attachment storage, voice controls, full-face presentation adapter, local static server, and tests were added on October 27, 2026. Existing MERLIN assets and the existing vendored MIT Three.js build are reused; no new runtime package or model provider was introduced. Brand logo origins and license/trademark notes are recorded in [LOGOS.md](../public/phone/LOGOS.md). Three generic or unavailable marks use documented plain labels. The owner's design reference screenshots are visual references only and are not redistributed.

## Verification and next step

Run `node --test test/phone-demo.test.js test/phone-server.test.js`. Browser evidence and the scoped visual review are in `.impeccable/review/phone/`; the final checked behavior is recorded in [STATUS.md](STATUS.md). Browser automation uses synthetic data and an isolated profile. Automated checks do not establish native installation, real-device voice quality, cross-device synchronization, live account access, or physical-device compatibility.

Next: owner review on the target phone layout, then define authentication and a shared assistant API so both apps can use the same Meta-backed assistant, household memory, and service authorization. This demo remains separate from the working Meta assistant and does not replace its foundation.
