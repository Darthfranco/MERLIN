# Phone connection logos

These assets identify services in the **local simulated connection menu**. Their presence does not imply a live integration, supported hardware, account access, endorsement, or a partnership. The phone catalog imports all 45 Connection Center entries and adds nine account-service demonstrations; existing availability notes and restrictions remain intact.

All images are bundled locally. Opening the phone demo makes no logo/CDN request and sends no connection state to a third party.

## Provenance and rights

- **Simple Icons:** vectors from the [Simple Icons repository](https://github.com/simple-icons/simple-icons), pinned to commit `90646e4bf7f3b89df6c37e65baf3e7bc759a517c`. Alexa and Outlook use the identifiable marks from release `11.15.0`. The collection is [CC0 1.0](https://github.com/simple-icons/simple-icons/blob/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/LICENSE.md); the full notice is copied in [logos/simple-icons-license.txt](logos/simple-icons-license.txt). A brand-color `fill` attribute was added; paths remain unchanged. Trademark rights are not waived by the collection license.
- **Google product logos:** Gmail, Calendar and Drive use Google's product-logo SVGs directly, retaining their colors and proportions. They are identification marks, not MERLIN artwork; Google retains its brand/trademark rights.
- **Home Assistant Brands:** PNGs from the [Home Assistant brand repository](https://github.com/home-assistant/brands), pinned to `f4bc3c013b5b8f8daf84a96a460b891433690a74`. Visual pixels are unchanged; source metadata was added to the PNG container. Its [Trademark Legal Notices](https://github.com/home-assistant/brands#trademark-legal-notices) state that names and marks belong to their respective owners and are used for identification. This document does not assert a blanket open-source license for those brand marks. Use is limited here to the named integration/service menu.
- **Original text labels:** `camera-standards.svg`, `ratgdo-label.svg`, and `myq-label.svg` are plain typographic labels made for this demo, **not official logos**. RTSP/ONVIF is a multi-protocol entry with no single company mark; no verified suitable asset was bundled for ratgdo or the restricted myQ route. The services expose `logoKind: 'label'` for these cases. They should be replaced with verified official assets if those entries advance beyond this preview.

The full machine-readable source URLs and bundled-file SHA-256 hashes for downloaded marks are in [logos/sources.json](logos/sources.json). SVGs were checked for script, event-handler, external-image, and external-reference content before bundling. PNG signatures and all catalog paths were checked. Each of the 21 PNGs also carries an `impeccable:prompt` text chunk that explicitly says it is a source asset, not AI-generated, and records its exact pinned URL. The manifest preserves `sourceSha256` for the original download and `sha256` for the shipping file. Removing only that provenance chunk reproduces every original byte, confirming that image data, color profile, transparency, and visual pixels were not changed. `embed-prompt.mjs --scan public/phone/logos` reports **21 rasters, 0 missing**. Brand-specific usage rules still apply; these files are not a reusable generic icon pack.

## Files and sources

| Local file | Collection | Exact source |
| --- | --- | --- |
| [amazon-alexa.svg](logos/amazon-alexa.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/11.15.0/icons/amazonalexa.svg) |
| [apple.svg](logos/apple.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/apple.svg) |
| [apple-music.svg](logos/apple-music.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/applemusic.svg) |
| [aqara.png](logos/aqara.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_brands/aqara/icon.png) |
| [august.png](logos/august.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_brands/august/icon.png) |
| [dropbox.svg](logos/dropbox.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/dropbox.svg) |
| [ecobee.png](logos/ecobee.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_integrations/ecobee/icon.png) |
| [enphase.png](logos/enphase.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_integrations/enphase_envoy/icon.png) |
| [eufy.png](logos/eufy.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_brands/eufy/icon.png) |
| [eve.png](logos/eve.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_brands/eve/icon.png) |
| [ge-appliances.png](logos/ge-appliances.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/custom_integrations/ge_appliances/icon.png) |
| [gmail.svg](logos/gmail.svg) | Google product logo | [Upstream asset](https://fonts.gstatic.com/s/i/productlogos/gmail_2020q4/v8/192px.svg) |
| [google.svg](logos/google.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/google.svg) |
| [google-calendar.svg](logos/google-calendar.svg) | Google product logo | [Upstream asset](https://fonts.gstatic.com/s/i/productlogos/calendar_2020q4/v8/192px.svg) |
| [google-cast.svg](logos/google-cast.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/googlecast.svg) |
| [google-drive.svg](logos/google-drive.svg) | Google product logo | [Upstream asset](https://fonts.gstatic.com/s/i/productlogos/drive_2020q4/v8/192px.svg) |
| [google-home.svg](logos/google-home.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/googlehome.svg) |
| [gree.png](logos/gree.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_brands/gree/icon.png) |
| [home-assistant.svg](logos/home-assistant.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/homeassistant.svg) |
| [home-connect.png](logos/home-connect.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_integrations/home_connect/icon.png) |
| [ikea.svg](logos/ikea.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/ikea.svg) |
| [irobot.svg](logos/irobot.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/irobot.svg) |
| [lg.svg](logos/lg.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/lg.svg) |
| [lutron.png](logos/lutron.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_brands/lutron/icon.png) |
| [matter.png](logos/matter.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_integrations/matter/icon.png) |
| [midea.png](logos/midea.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_brands/midea/icon.png) |
| [mqtt.svg](logos/mqtt.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/mqtt.svg) |
| [notion.svg](logos/notion.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/notion.svg) |
| [outlook.svg](logos/outlook.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/11.15.0/icons/microsoftoutlook.svg) |
| [philips-hue.svg](logos/philips-hue.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/philipshue.svg) |
| [rabbit-air.png](logos/rabbit-air.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_integrations/rabbitair/icon.png) |
| [rachio.png](logos/rachio.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_integrations/rachio/icon.png) |
| [reolink.png](logos/reolink.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_integrations/reolink/icon.png) |
| [ring.svg](logos/ring.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/ring.svg) |
| [roborock.png](logos/roborock.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_integrations/roborock/icon.png) |
| [samsung.svg](logos/samsung.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/samsung.svg) |
| [schlage.png](logos/schlage.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_integrations/schlage/icon.png) |
| [shelly.svg](logos/shelly.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/shelly.svg) |
| [smartthings.svg](logos/smartthings.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/smartthings.svg) |
| [sonos.svg](logos/sonos.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/sonos.svg) |
| [spotify.svg](logos/spotify.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/spotify.svg) |
| [switchbot.png](logos/switchbot.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_brands/switchbot/icon.png) |
| [tp-link.svg](logos/tp-link.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/tplink.svg) |
| [ubiquiti.svg](logos/ubiquiti.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/ubiquiti.svg) |
| [vesync.png](logos/vesync.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_integrations/vesync/icon.png) |
| [wallbox.png](logos/wallbox.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_integrations/wallbox/icon.png) |
| [yale.svg](logos/yale.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/yale.svg) |
| [z-wave.png](logos/z-wave.png) | Home Assistant Brands | [Upstream asset](https://raw.githubusercontent.com/home-assistant/brands/f4bc3c013b5b8f8daf84a96a460b891433690a74/core_integrations/zwave_js/icon.png) |
| [zigbee.svg](logos/zigbee.svg) | Simple Icons | [Upstream asset](https://raw.githubusercontent.com/simple-icons/simple-icons/90646e4bf7f3b89df6c37e65baf3e7bc759a517c/icons/zigbee.svg) |

## Catalog interface

`services.js` exports `SERVICES` (also `services`), `SERVICE_CATEGORIES` (also `groups`), `DEFAULT_CONNECTED_IDS`, and `getService(id)`. Each record has `id`, `name`, `category`, `description`, `logo`, `brandColor`, `kind`, and `demoOnly: true`, alongside the original Connection Center fields. All 45 original IDs are preserved. New account IDs are `spotify`, `apple-music`, `google-calendar`, `outlook-calendar`, `gmail`, `outlook`, `google-drive`, `dropbox`, and `notion`.

Logos are intended to sit within a light icon tile. No library or runtime dependency was added. The demo's initial connected selections are Philips Hue and Google Calendar only; this seed is a fictional demonstration, not a stored household preference. Spotify is explicitly typed-only and does not fetch or persist music metadata.

## Original contributions and reused character asset

New work for this phone surface is the catalog presentation adapter, nine expressly simulated account-service records, the bundled logo mapping and provenance records, and the three original typographic fallback labels. The third-party brand artwork itself is reused, not a MERLIN contribution. No image-generation model, logo redraw, or new runtime package was used.

The phone app also references the existing owner/project character still at [`assets/merlin-character/previews/merlin-fullscreen-face.png`](../../assets/merlin-character/previews/merlin-fullscreen-face.png) for its greeting and face fallback. That 1600 × 1200 Cycles render comes from the existing MERLIN interaction scene, as recorded in the [character asset notes](../../assets/merlin-character/README.md#previous-expressive-acting-panel-interaction-and-full-frame-face). It was not created, replaced, or metadata-edited for the phone task. Its reviewed source hash is `469499ad2c2b812da2f5b7e87785af1755913ee9c8ba5e9457d0eafdef86d8a1`. The owner's design-reference attachments are not redistributed.
