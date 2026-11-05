# Real connectors, setup guides, and web lookup

Updated November 1, 2026. This replaces the earlier simulated connection previews: **nothing in MERLIN's connection screens is simulated any more.** A service is *connected* only after MERLIN has contacted it with the saved credentials and the service accepted them. Everything else is a guide or is marked unsupported, and following a guide never connects MERLIN by itself.

**One opt-in exception, November 3, 2026:** the owner chose clearly labeled demo devices for the hackathon demo. With `MERLIN_DEMO_HOME=1`, a simulated [Demo home](#demo-home-opt-in-simulated) is added and labeled as simulated everywhere it appears. It is off by default and never looks like a real integration.

Short version of what is real:

| Service | What MERLIN can do | Live-tested? |
|---|---|---|
| **Web search** (Meta's built-in search) | Searches the web whenever you ask or the answer can change; shows titles, links and result text | **Yes**, `npm run check:lookup` against the real Meta API |
| **Page reader** (`read_web_page`) | Opens a link you gave it, or one its own search returned, and reads the text | **Yes**, against real public pages |
| **Spotify** | Typed search and playback controls (existing integration) | No credentials on this machine |
| **Home Assistant** | Lights, switches, fans, blinds, locks (lock only), thermostats, vacuums, scenes | No (mock tests only) |
| **Philips Hue** | Lights, rooms, scenes | No |
| **Shelly** (Gen2 and newer) | Switches, lights, roller shutters | No |
| **SwitchBot** | Plugs, curtains/blinds/shades, humidifiers, Bots, lock (lock only) | No |
| **Rachio** (controllers) | Start a zone for N minutes, stop watering | No |

"Mock tests" prove how MERLIN builds requests and reads responses from the service's documented shapes. They do **not** prove a live account or device works. See [Still needs live verification](#still-needs-live-verification).

## How connecting works

Everything flows through one server-side hub (`src/connectors/hub.js`). The Connection Center page, the big-screen panel and the assistant all read the same status from it.

Status words (identical everywhere):

- **Connected**: verified. The service accepted the saved credentials at the time shown.
- **Setup unfinished** (`saved`): settings are saved but access is not proven yet (for example, a Hue address saved before pairing). MERLIN cannot use it and gives the model no tools for it.
- **Needs attention**: credentials that worked were later rejected, or a pinned certificate changed. Tools are removed until it is reconnected.
- **Not connected**: nothing saved.
- **Unavailable**: the service cannot run in this setup.

Rules the hub enforces:

- Connecting contacts the real service first. If that fails, **nothing is saved** and the error message says what failed (bad credentials, unreachable, rate limited) without echoing the secret.
- A temporary outage keeps the service Connected but records the issue; an authentication failure flips it to Needs attention.
- Disconnect revokes access where the service supports it, and **always** deletes the local credentials. If revocation is not possible, the message says exactly what to do in the service's own settings.
- A disconnect that happens while a setup step is still running wins; the late result is discarded.
- Device tools (`home_list_devices`, `home_get_state`, `home_control`) exist only while at least one connector is verified.

### Credentials

Credentials travel to the local server once, in the body of a request over the loopback connection (127.0.0.1), and are stored in `data/connectors.json` (ignored by git, owner-only `0600` file in a `0700` folder, atomic writes). The file is **not encrypted by MERLIN**; protect the computer and its disk. Credentials are never returned by any API, shown in the page after submit, kept in browser storage, written to logs or traces, or sent to Meta. The status API reports only *whether* a secret is saved.

Device names and states that a tool returns (for example "Kitchen light: on") are sent to Meta so it can write the reply. Credentials, tokens, bridge keys and addresses are not.

### Device model and safety limits

Connectors expose devices in one vocabulary: `turn_on`, `turn_off`, `toggle`, `set_brightness`, `set_color_temperature`, `set_position`, `open`, `close`, `stop`, `lock`, `activate`, `press`, `start`, `set_temperature`. MERLIN resolves the device **name** locally (so the model never gets native IDs), asks which one when a name is ambiguous, and refuses actions a device does not support.

Deliberate limits (MERLIN decisions, open to the owner changing them):

- **No unlock.** MERLIN can lock a door; there is no unlock action anywhere.
- **No garage doors, gates or exterior doors.** Home Assistant covers with those device classes are listed read-only, and so are Shelly shutters whose name looks like a garage door, gate or door. SwitchBot's curtain and blind devices are not garage doors; a SwitchBot Lock can only lock.
- No alarm panels, scripts, automations, or oven/appliance programs.
- A receipt written by code, not the model, reports every outcome: *confirmed* (the service reported the new state), *accepted* (the service took the command but has not confirmed), or *failed*. If the model claims success the receipt did not support, the claim is removed from the reply.

## The connectors

### Home Assistant
- **You need:** Home Assistant on your network and a long-lived access token (profile → Security → Long-lived access tokens).
- **MERLIN proves access** with `GET /api/` and `GET /api/config`.
- **Controls:** lights (on/off, brightness, color temperature), switches, fans (on/off), blinds/shades (open, close, stop, position), locks (lock only), thermostats (set temperature, on/off where supported), vacuums (start, stop), scenes.
- **Not yet:** media players, cameras, alarm panels, garage doors, scripts and automations.
- **Disconnect** removes the token from MERLIN. Home Assistant tokens cannot be revoked from outside; delete the MERLIN token in your Home Assistant profile.
- **Limit:** use the `http://` address on your home network; an `https` address with a self-signed certificate is not accepted.
- This is also the route for most other brands (below).

### Philips Hue
- **You need:** a Hue Bridge (square, API v2) on your network and physical access to its link button.
- **Flow:** enter the bridge address (or use *Find my bridge*, which asks Signify's discovery service and so shares your public IP with Signify) → MERLIN contacts the bridge and pins its certificate (status: *Setup unfinished*) → press the link button, choose *Pair* within 30 seconds → MERLIN verifies the key against the bridge and shows *Connected*.
- **Controls:** lights (on/off, brightness, color temperature), rooms (grouped), scenes (recall).
- **Security:** the bridge uses a private-CA certificate, so MERLIN pins its fingerprint on first use and checks it **before** sending the key. A changed certificate stops all traffic and shows Needs attention.
- **Disconnect** asks the bridge to delete MERLIN's key; if the bridge does not confirm, the message says to remove it in the Hue app.
- **Not yet:** sensors/buttons, entertainment areas, creating scenes, the old round bridge (v1).

### Shelly (second generation and newer)
- **You need:** a Shelly Plus/Pro/Gen3/Gen4 device on your Wi‑Fi and its address; its password if one is set (username is always `admin`).
- **Controls:** switches (on/off/toggle), lights (on/off, brightness), roller shutters (open, close, stop, position; shutters whose name looks like a garage/gate/door are read-only). Several devices can be added, each verified.
- **Notes:** Shelly's local API is plain HTTP on your home network; the optional digest authentication protects the password, not the traffic. First-generation Shelly devices are refused with a clear message. Shelly has no remote access to revoke, so Disconnect forgets the saved addresses and passwords.

### SwitchBot
- **You need:** SwitchBot account and Hub, app 6.14 or newer, and your **token** and **secret** (Profile → Preferences → tap App Version 10 times → Developer Options → Get Token).
- **Controls:** plugs (on/off/toggle), curtains and roller shades (open/close/position), blind tilt (open/close), humidifiers (on/off), Bots (press), locks (lock only). Infrared remotes, cameras, lights and sensors are not exposed.
- **Notes:** a Bot presses whatever it is mounted on (a light switch, a coffee maker), which MERLIN cannot know, so it is exposed only for an explicit request. SwitchBot relays commands through its cloud; it limits personal use to 10,000 requests a day, and results are reported as accepted unless the follow-up status matches. Regenerating the token in the app invalidates the old one.

### Rachio
- **You need:** a Rachio smart sprinkler controller and your API key (app → Profile → API key → Copy).
- **Controls:** start a named zone for a number of minutes **you give** (1–180; MERLIN asks if you do not), and stop all watering on a controller.
- **Not yet:** Smart Hose Timers (different API), schedules, rain delay, standby. Rachio allows 3,500 requests a day.

### Spotify
Unchanged, with its own page and OAuth flow ([SPOTIFY.md](SPOTIFY.md)). The hub reports its real status (*Connected* only when Spotify issued tokens; *Setup unfinished* when only the Client ID is saved) so the Connection Center and big screen agree with the Spotify panel.

### Demo home (opt-in, simulated)
Chosen by the owner on November 3, 2026, when asked how lights, the oven and the gym speaker should work in the hackathon demo: **labeled demo devices.** `src/connectors/demo-home.js`.

- **Off by default.** It exists only when the server starts with `MERLIN_DEMO_HOME=1`, which also connects it once (recorded in ignored `data/connectors.json`, with no credentials). Remove the setting and restart, and it is gone: the hub drops records for connectors that are not registered.
- **Devices:** Living room lights, Kitchen lights, Gym lights (on, off, toggle, brightness), Gym speaker (power on, off, toggle; it plays nothing), and Oven (on, preheat to 170–550 °F, off). They live in the server process and all start off after a restart. Nothing physical is controlled.
- **Same path as a real connector:** the hub's tools, device-name matching, saved rules, the preheat range check and code-written receipts. A demo receipt reads "Turned on Gym lights in the demo home." Several in one reply share one label: "Turned on Gym lights and turned on Gym speaker in the demo home."
- **Labeled everywhere:** the service is named *Demo home*. The model is told the devices are simulated and says so when asked. Each panel has an amber **DEMO** pill and a "Demo device · simulated" badge. The Activity list shows *Demo (simulated)*, and `/api/companion/state` marks the category `simulated: true`.
- **Panels:** a confirmed device action now pulls out its panel: lights, oven (with "Preheating to 400°F") or the new speaker panel. Two devices in one request fill both sides. This works for real connectors too, but only when the service reported the result. A real light that only accepted the command shows "One moment…", never a guessed state.

## Services with guides only

These do not connect MERLIN. The guide helps you set up the device or its Home Assistant integration; the "What MERLIN can do afterward" line is what actually becomes possible once **Home Assistant is also connected to MERLIN**.

| Service | What MERLIN can control afterward (through Home Assistant's entities) | Official guide |
|---|---|---|
| Matter devices | lights, switches, blinds, locks (lock only), thermostats | [guide](https://www.home-assistant.io/integrations/matter/) |
| MQTT devices | lights, switches | [guide](https://www.home-assistant.io/integrations/mqtt/) |
| Zigbee devices | lights, switches | [guide](https://www.home-assistant.io/integrations/zha/) |
| Z-Wave devices | switches, locks (lock only), thermostats | [guide](https://www.home-assistant.io/integrations/zwave_js/) |
| TP-Link Tapo & Kasa | lights, switches (TP-Link publishes no official API) | [guide](https://www.home-assistant.io/integrations/tplink/) |
| Sonos, Google Cast, LG webOS, Amazon Echo | nothing yet (media players are not controlled) | see catalog |
| Reolink, RTSP/ONVIF, UniFi Protect, Ring | nothing yet (cameras and alarms are not controlled) | see catalog |
| LG ThinQ, Midea, Gree | air conditioners and other thermostats | see catalog |
| SmartHQ, Home Connect, Wallbox, Enphase | nothing yet | see catalog |
| Samsung SmartThings | lights, switches, locks (lock only), thermostats (its personal tokens last 24 hours, so there is no direct connector) | [guide](https://www.home-assistant.io/integrations/smartthings/) |
| Lutron Caséta, IKEA, Aqara, Eve | lights/switches/blinds as each exposes them | see catalog |
| ecobee | thermostats (Home Assistant now signs in with your ecobee account; no developer key) | [guide](https://www.home-assistant.io/integrations/ecobee/) |
| Yale & August, Schlage | locks (lock only) | see catalog |
| Roborock, iRobot | vacuums (start, stop) | see catalog |
| Levoit, Rabbit Air | purifier/humidifier fans (on/off) | see catalog |
| ratgdo | nothing (MERLIN never moves garage doors) | see catalog |

## Services with no supported route

| Service | Why |
|---|---|
| Apple Home | Reachable only from a native Apple app with HomeKit access; MERLIN has none yet |
| Google Home APIs and Google Home MCP | Restricted to approved partners / early access |
| Apple HomePod | MERLIN has no AirPlay sender |
| eufy cameras | Only a model-specific stream MERLIN does not consume |
| myQ | The vendor blocked third-party access |

## Why these were chosen (and not others)

"Easy" meant: a documented API with a manageable integration using our current stack (an API key, a simple token, or a supported local connection). Findings from the official documentation on November 1, 2026:

- **Easy, built:** Home Assistant (REST + long-lived token), Hue (local v2 API + link button), Shelly Gen2+ (documented local RPC), SwitchBot (open API with token + secret), Rachio (public API key).
- **Not built, with reasons:** Sonos (its Control API needs a developer integration whose redirect URL must be a publicly routable HTTPS address); SmartThings (personal access tokens now expire after 24 hours; a durable integration needs a registered OAuth service); TP-Link (no official API); Ring, Roborock, iRobot, Levoit, Schlage, Yale/August (no official public API for individuals); Home Connect and LG ThinQ (developer registration plus appliance programs, including oven safety, that need hardware to verify); Apple/Google (native or partner-only); myQ (blocked by the vendor). ecobee works through Home Assistant's current account-login flow.
- The older October 27 catalog notes were re-checked; every official guide link in the catalog resolves (SmartHQ blocks automated requests but loads in a browser).

## Web lookup

See [PROTOTYPE.md](PROTOTYPE.md#web-lookups) for the policy. Changes on November 1, 2026:

- **Did search work before?** Yes. The October 31 work already routed every explicit "look it up" and every time-sensitive/factual question to Meta's built-in `web_search` and verified a search completed. A live `npm run check:lookup` run was repeated; results are in [STATUS.md](devlog.md).
- **Provider and key:** search uses Meta's hosted `web_search` through the same `META_API_KEY` as chat. There is no separate search key. When the key is missing, the main page says **Web search unavailable: add META_API_KEY**, and `/api/state` reports `search.available: false`. MERLIN never substitutes invented results.
- **Result text:** each source shows its title and link. A live check on November 1, 2026 found that Meta's search returns a `snippet` field on every result but it is **always empty**, so MERLIN shows any provider text if one ever arrives (kept out of traces) and otherwise offers **Show excerpt** under each source on the main page. That button fetches the start of the page on demand through the same safe reader, only for links that answer actually showed (`POST /api/sources/excerpt`), and a saved web-search ban blocks it. The model can also read a page itself with `read_web_page`; in the live check it did so when it needed more than the title.
- **Reading a page:** `read_web_page` (`src/web-page.js`) lets the model read one page when snippets are not enough. It opens only a link you typed or one MERLIN's own search returned (never a link a page supplied), at most 4 pages per request. It allows only public http(s) pages on ports 80/443/8080/8443; resolves DNS itself and connects to the checked address (no rebinding); revalidates every redirect (3 max); times out after 8 seconds; reads at most 1 MiB; accepts text types only; strips scripts, styles and navigation; returns at most about 6,000 characters. The text is returned to the model marked **untrusted data** and can never change a rule, a permission or a device.
- **Standing instructions:** a saved rule that blocks `web_search` also blocks `read_web_page`.

## Environment variables

| Variable | Needed for | Notes |
|---|---|---|
| `META_API_KEY` | Chat **and web search** | Server only, in ignored `.env` |
| `META_MODEL` | Model choice | Default `muse-spark-1.3` |
| `PORT` | Local server port | Default 3000 |
| `SPOTIFY_CLIENT_ID` | Spotify (optional; can be set in the page instead) | Public identifier, no secret |
| `MERLIN_DEMO_HOME` | The labeled, simulated demo home | `1` turns it on; anything else leaves it off |

Home Assistant, Hue, Shelly, SwitchBot and Rachio take no environment variables: you enter their details in the Connection Center at <http://127.0.0.1:3000/connections/>, and they are stored in `data/connectors.json`. `npm run connections` (port 3002) is now a guide-only reference with no connect buttons.

## Still needs live verification

Mock tests cover request shapes, signatures, error mapping, safety limits and status handling. Nobody has run these against real services or devices yet:

- **Home Assistant:** a real instance and token (service names, states and unit handling).
- **Philips Hue:** a real bridge: the pairing response shape, certificate pinning against the bridge's private CA, the v1 key-delete endpoint, `zigbee_connectivity` reachability.
- **Shelly:** a real Gen2+ device with and without a password (digest nonce lifetime and stale handling), cover behavior.
- **SwitchBot:** a real account: signature casing (the official README is inconsistent between prose and samples; the connector sends the upper-case form), Roller Shade position parameter, the exact `deviceType` strings, status timing after a command.
- **Rachio:** a real controller: the idle `current_schedule` reply, cloud lag after a start.
- **Spotify:** an authorized account (unchanged).

Once you have connected a service, run:

```sh
npm run check:connectors
```

It copies `data/connectors.json` to a temporary file, re-verifies each saved connector against its real service, counts the devices it can see, and **sends no control commands**. It prints counts, not device names. Then try one harmless control by hand (for example a lamp on and off) and note the result here.

When a live check passes, record the date and model/firmware here.
