# MERLIN Connection Center

The Connection Center is where a household sets up connections to existing smart-home equipment and services. **Since November 1, 2026 it is no longer a simulation.** Served by MERLIN at <http://127.0.0.1:3000/connections/>, it connects the services MERLIN has real connectors for (Home Assistant, Philips Hue, Shelly, SwitchBot, Rachio, and Spotify's existing flow), and shows clearly labeled setup guides for the rest. The full list, supported actions, limits and live-verification status are in [CONNECTORS.md](CONNECTORS.md). It still does not select MERLIN's final app platform or integration backend.

## Run

Start MERLIN (`npm start`) and open <http://127.0.0.1:3000/connections/>, or choose **Connection Center** on the main page. `npm run connections` still starts a separate **guide-only** copy at <http://127.0.0.1:3002>: it can search the catalog and read guides, but it has no API and no connect buttons, and it says so on the page. For source changes to that server use `npm run dev:connections`; choose another port with `CONNECTIONS_PORT=3003 npm run connections`.

## Using the Connection Center

- Search company names, aliases, devices, or categories; narrow by category, company and Easy / Medium / Hard household setup difficulty.
- Every card says how MERLIN can reach the service: **Connects to MERLIN** (a real connector), **Through Home Assistant** (a guide; MERLIN reaches the device only through Home Assistant's entities), or **No supported route**.
- Real connectors show a setup form for exactly what that service needs. Secret fields are password inputs, are never prefilled, and are cleared after submit. A connector shows **Connected** only after the service accepted the credentials; a multi-step setup (Hue) shows **Setup unfinished** between steps.
- Guides list what you need, the steps, the official links, **what MERLIN can do afterward**, and **what is still missing**. They never claim that following them connects MERLIN.
- Connected services can be re-verified and disconnected; Disconnect revokes access where the service allows it and always removes the local credentials.

## Data and boundaries

Credentials and connection state live in the server's ignored `data/connectors.json` (see [CONNECTORS.md](CONNECTORS.md#credentials)). The page keeps nothing sensitive in browser storage and never shows a saved secret. The old browser-only demo list (`merlin.connections.demo.v1`) and the server-side preview list (`data/connections.json`) are obsolete and ignored; you may delete them. The page is served with a strict content security policy: no inline scripts or styles, same-origin requests only, no camera, microphone or location.

## Files and maintenance

- `public/connections/catalog.js`: researched catalog, categories, setup copy, source links, pure search/filter logic. Each entry carries an `integration` record.
- `public/connections/integrations.js`: the single honest statement of what MERLIN can do for each service: real connector, through Home Assistant (with the entity types it controls), or no supported route. Edit this file when a connector is added.
- `public/connections/index.html`, `styles.css`, `app.js`, `icons.js`: the responsive directory, live setup forms and guides.
- `src/connectors/`: the hub and the connectors (`hub.js`, `base.js`, `home-assistant.js`, `hue.js`, `shelly.js`, `switchbot.js`, `rachio.js`, `spotify.js`).
- `src/connections-server.js`: importable static server and CLI entry point for the guide-only copy on port 3002.
- `test/connections-*.test.js`, `test/connector-*.test.js`: catalog, page server, hub and per-connector checks.

No new runtime package, external font, third-party image, or downloaded brand asset is used. Icons are original simple SVG geometry. This page inherits the existing prototype's visual vocabulary; its layout is documented in [Connection Center design](CONNECTIONS_DESIGN.md).

The October 27, 2026 research was re-checked against official documentation on November 1, 2026 (see [CONNECTORS.md](CONNECTORS.md#why-these-were-chosen-and-not-others)). A catalog entry is still not proof of working MERLIN hardware support: only the services marked **Connects to MERLIN** have a connector, and none has yet been run against a real account or device.

## On MERLIN's large screen

The home companion (`/companion/`) shows the same catalog and the same live connector status on the big ceiling screen when someone asks how to connect something or asks for something that is not connected. Tiles show the real status; setup views show what you need, what MERLIN can do afterward and what is missing. Credentials are never typed there: **Set up** opens this page in a new tab. See the [plan and update](ORCHESTRATION.md#connection-touchscreen-plan--october-31-2026).
