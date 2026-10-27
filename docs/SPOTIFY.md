# Spotify in the local test app

The owner requested Spotify integration on October 26, 2026. MERLIN now has a Spotify Web API adapter for the typed local prototype. It controls an existing Spotify app or Spotify Connect device; this page does not itself stream audio or create a speaker.

## Connect an account

1. Create or open an app in the [Spotify developer dashboard](https://developer.spotify.com/dashboard). Choose Web API access. Spotify currently requires a Premium app owner for development mode, and playback controls require Premium. Add the intended test account under the app's **Settings → Users Management**. Development mode permits up to five allowlisted users. [Spotify requirements](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
2. Register the redirect URI shown in MERLIN's Spotify setup. With the default port it is `http://127.0.0.1:3000/api/spotify/callback`. Open MERLIN at `127.0.0.1`, not `localhost`, for this connection. Spotify allows HTTP for literal loopback addresses and rejects `localhost` redirect URIs. [Redirect URI requirements](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)
3. Paste the app's **Client ID** into the Spotify setup panel and save, or set `SPOTIFY_CLIENT_ID` in ignored `.env` before starting the server. A Client ID is public application identification. MERLIN does **not** request a client secret or a Spotify password.
4. Choose **Connect Spotify** and approve the requested access on Spotify's own page. Open Spotify on the desired computer, phone, or speaker. Refresh devices in MERLIN and select the destination when needed.

No Spotify developer credentials are bundled. A passing offline test suite does not establish access to a real account. See [current verification](STATUS.md).

## Available controls

- Search tracks, artists, albums, and playlists; inspect matching results with links back to Spotify.
- Browse the connected account's playlists.
- Play a result or resume, pause, skip forward/back, adjust volume, toggle shuffle, set repeat, add a track to the queue, and transfer playback to a selected available device.
- Ask through typed chat, for example “Pause Spotify,” “Set Spotify volume to 25 percent,” or “Play [track] by [artist] on Spotify.” Use the panel to choose between ambiguous results. Existing user-defined routines can contain a typed music request; saving or reading a routine does not execute it.

Playback requires an available, controllable Spotify device. Account, device, market, and Spotify API restrictions still apply. Volume is not supported by every device. The API's successful response means Spotify accepted a command; the playback panel shows subsequently observed state. Player endpoints do not guarantee immediate ordering, so tightly timed choreography is not supported. [Playback API](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback)

The service resolves an unambiguous exact search match locally. It does not guess between ambiguous tracks, invent device IDs, select an arbitrary speaker, or retry uncertain playback mutations automatically. Rate limits produce a wait-and-retry message; refreshes are bounded and do not run in the timer's polling loop. HTTP requests have timeouts. The request ledger protects repeated manual/chat requests from duplicate execution, including after restart.

## Data and privacy

This is a local development integration, with one connected Spotify account for the shared household. It is not a deployed multi-user service.

- Login and consent happen at Spotify. Authorization Code with PKCE uses a one-use, expiring verifier and state, bound to an HttpOnly browser cookie. Access/refresh tokens stay on the server in ignored `data/spotify.json` with owner-only file permissions. The file is not encrypted by MERLIN; protect the computer/account and disk. No tokens enter the browser, chat, trace, repository, or Meta request. [PKCE flow](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)
- Requested scopes are `user-read-playback-state`, `user-modify-playback-state`, and `playlist-read-private`. They support the implemented controls, device status, and playlists. No email, listening-history, or playlist-write permission is requested.
- Music queries and commands go to Spotify. Retrieved track/artist/playlist/device metadata goes directly to the local panel, with links back to Spotify. It is held only temporarily in server/browser memory for the current interface and is not written into household learning, conversation history, or traces.
- Typed chat and user-authored routine requests still go to standard Meta as described in [prototype privacy](PROTOTYPE.md#data-and-privacy). Spotify tools return only code-generated outcome receipts to Meta, never Spotify catalog, playlist, device, or playback metadata. MERLIN does not analyze listening history, learn preferences from Spotify, or train a model using Spotify content.
- **Disconnect Spotify** removes local tokens and transient Spotify results and prevents pending refresh/authorization work from restoring the connection. It does not delete your Spotify playlists or cancel your subscription. You can also remove the app in [Spotify account access settings](https://www.spotify.com/account/apps/). User-authored chat and routines remain governed by Memory lab deletion controls. **Delete all memory** does not disconnect Spotify or cancel timers.

Spotify's current developer policy restricts voice assistants, alarm/ringtone functions, and ingesting Spotify content into AI models. This integration is limited to typed requests and manual controls; it adds no microphone, spoken music control, or Spotify alarms. Future voice/product distribution requires a separately supported arrangement and review of Spotify's terms. [Spotify developer policy](https://developer.spotify.com/policy)

## Implementation and checks

`src/spotify.js` owns OAuth, token refresh, local state, argument validation, Spotify requests, device selection, and local result matching. `src/spotify-tools.js` is the metadata-free assistant boundary. `src/server.js` exposes local routes and binds the OAuth callback to its initiating browser. `public/spotify.js` renders metadata safely and uses the normal local API boundary. Compiled music tool bans apply to chat and direct panel actions.

Tests use mocked Spotify HTTP responses and temporary files. Coverage includes PKCE/state/expiry, token refresh, disconnect races, strict inputs, missing devices, permission/rate-limit failures, duplicate controls, OAuth cross-site boundaries, setup without action execution, and keeping Spotify content out of Meta and memory. No third-party runtime dependency was added. Spotify API integration, its UI, and its tests are new October 26, 2026 work; this does not resolve the hackathon's documented build-start ambiguity.
