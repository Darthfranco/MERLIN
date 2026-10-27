# MERLIN Connection Center

The owner requested a separate local browser prototype for exploring connections to existing smart-home equipment. This is a simulated setup experience, not a live device integration. It does not select MERLIN's final app platform or integration backend.

## Run

With the project's supported Node.js version, run:

```sh
npm run connections
```

Open <http://127.0.0.1:3002>. For source changes to the server, use `npm run dev:connections`. To choose another port, run `CONNECTIONS_PORT=3003 npm run connections`.

The server uses only Node standard libraries, binds to loopback, and does not load `.env`, the assistant, Meta, Spotify, or the voice lab. It can run alongside those existing surfaces.

## Using the preview

- Search company names, aliases, devices, or categories. Search tokens are combined, case-insensitive, and accent-insensitive.
- Narrow results by category, company, and Easy / Medium / Hard setup difficulty. The rating describes household setup, not our development effort; prerequisites are explained in each guide.
- Easy entries have a direct demo Connect button. Every entry's name opens a dedicated setup page; Medium and Hard entries also have a View setup button.
- Guides describe the proposed real connection route, prerequisites, steps, model limitations, and a primary setup reference. They are reference material, not instructions that must be completed to try the demo.
- The demo action changes the entry to Connected, explicitly labeled Demo. It does not authenticate, discover, verify, or control anything. Restricted vendor routes can also be previewed without suggesting those real integrations are available.
- The Connected view supports individual disconnect and clear-all with a local confirmation. Browser back returns from setup to the previous list and filters.

## Data and boundaries

The only persistent state is a versioned list of catalog IDs in this origin's `localStorage`, under `merlin.connections.demo.v1`. It contains no account details, passwords, tokens, addresses, or device settings. Unknown IDs are discarded. Invalid/unavailable storage produces visible feedback and a usable page session. Clear demo connections removes the saved selections; it has no effect on other MERLIN stores or actual accounts. Different hostnames, ports, browser profiles, and private windows have separate browser storage.

The app makes no connection API calls. The server exposes only an allowlist of static files plus `GET /health`, which returns `{ "ok": true, "mode": "demo" }`. Mutations are unsupported; the browser's content security policy blocks fetch/WebSocket connections, third-party scripts, embedded frames, and inline scripts. Camera, microphone, and location permissions are disabled. Official reference links open only when clicked, in a separate tab.

## Files and maintenance

- `public/connections/catalog.js`: researched catalog, categories, setup copy, source links, and pure search/filter logic.
- `public/connections/index.html`, `styles.css`, `app.js`, `icons.js`: isolated responsive directory and setup flow.
- `public/connections/state.js`: validated browser-only demo storage.
- `src/connections-server.js`: importable static server and CLI entry point.
- `test/connections-*.test.js`: catalog/search, persistence, and HTTP boundary regression checks.

No new runtime package, external font, third-party image, or downloaded brand asset is used. Icons are original simple SVG geometry. This page inherits the existing prototype's visual vocabulary; its layout is documented in [Connection Center design](CONNECTIONS_DESIGN.md).

The October 27, 2026 research is a compatibility starting point. A catalog entry is not proof of working MERLIN hardware support. Before implementing a real adapter, recheck provider availability and terms, discover exact device capabilities, implement scoped authorization and truthful state feedback, and label simulator versus actual model/firmware verification. A public account-linking integration may require approvals unavailable to an individual developer account.
