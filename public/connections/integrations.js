// What MERLIN can really do for each catalog service. This file is the single honest answer used by the Connection Center,
// the big screen and the assistant. Rules:
//   native              MERLIN has its own working connector (src/connectors). Connecting proves access to the real service.
//   via-home-assistant  No connector of its own. Home Assistant (itself a native connector) already integrates the device, and
//                       MERLIN controls only the entity types listed in `can`. A guide helps the household set that up.
//   none                No supported way for MERLIN to control it. The entry says why.
// Following a guide never connects MERLIN by itself.

const HOME_ASSISTANT_CONTROLS = 'lights, switches, fans, blinds, locks (lock only), thermostats, vacuums and scenes';

/** Real connectors, with the setup copy that replaces the older generic steps. */
const NATIVE = {
  'home-assistant': {
    connector: 'home-assistant',
    afterwards: `MERLIN can list and control the ${HOME_ASSISTANT_CONTROLS} that Home Assistant exposes, and confirm the result when Home Assistant reports it.`,
    remaining: 'Not yet supported: media players, cameras, alarm panels, garage doors and gates (never moved by MERLIN), unlocking, scripts and automations.',
    setup: {
      description: 'Control the lights, switches, fans, blinds, locks (lock only), thermostats, vacuums and scenes that already work in your Home Assistant.',
      difficultyReason: 'Easy once Home Assistant is running and you can create an access token in your profile.',
      method: 'Home Assistant address and access token',
      requirements: ['Home Assistant running on your home network, with the device you want already working in it.', 'Its address, for example http://homeassistant.local:8123.', 'A long-lived access token created in your Home Assistant profile.'],
      steps: [
        { title: 'Find the address', body: 'Use the address you open Home Assistant at on this network, such as http://homeassistant.local:8123.' },
        { title: 'Create a token', body: 'In Home Assistant open your profile, choose Security, then Long-lived access tokens, and create one named MERLIN. Copy it now; Home Assistant shows it once.' },
        { title: 'Enter both in the Connection Center', body: 'Paste the address and token on this card. MERLIN contacts Home Assistant right away and only shows Connected if the token works.' },
      ],
      limitations: ['Only the entity types listed above are controllable.', 'A token can only be revoked in Home Assistant; Disconnect here removes it from MERLIN.', 'An https address with a self-signed certificate is not accepted; use the plain http address on your home network.'],
    },
  },
  'philips-hue': {
    connector: 'philips-hue',
    afterwards: 'MERLIN can list your lights, rooms and scenes, turn them on or off, dim them, set color temperature on lights that support it, and recall a scene.',
    remaining: 'Not yet supported: sensors and buttons, entertainment areas, creating or editing scenes, schedules, and the older round Hue Bridge (v1).',
    setup: {
      description: 'Control your Hue lights, rooms and scenes through your Hue Bridge on your home network.',
      difficultyReason: 'Easy with a Hue Bridge on your network and a few minutes next to it.',
      method: 'Local Hue Bridge connection',
      requirements: ['A Hue Bridge (the square version) on the same network, set up in the Hue app.', 'Physical access to the bridge to press its round link button.'],
      steps: [
        { title: 'Find the bridge', body: 'Enter the bridge’s address (shown in the Hue app under bridge settings, or on your router). Or choose Find my bridge; that asks Signify’s discovery service, which learns your public IP address.' },
        { title: 'Save the address', body: 'MERLIN contacts the bridge and remembers its security fingerprint. Nothing is usable yet.' },
        { title: 'Press the link button, then Pair', body: 'Press the round button on top of the bridge, then choose Pair within 30 seconds. Only then does MERLIN show Connected.' },
      ],
      limitations: ['Disconnect asks the bridge to remove MERLIN’s key. If that fails, remove it in the Hue app.', 'Works over your home network only.'],
    },
  },
  shelly: {
    connector: 'shelly',
    afterwards: 'MERLIN can turn Shelly switches and lights on or off, dim them, and open, close or position Shelly roller shutters.',
    remaining: 'Not yet supported: first-generation Shelly devices, power-meter readings, schedules, scripts, and RGB color.',
    setup: {
      description: 'Switch, dim and position second-generation Shelly relays, lights and shutters over your home network.',
      difficultyReason: 'Easy for a second-generation or newer Shelly (Plus, Pro, Gen3, Gen4) already on your Wi‑Fi.',
      method: 'Local Shelly device connection',
      requirements: ['A Shelly Plus, Pro, Gen3 or Gen4 device on your Wi‑Fi (first-generation devices are not supported).', 'Its address on your network.', 'Its password, if you set one in the Shelly web page.'],
      steps: [
        { title: 'Find the device address', body: 'Use your router’s device list or the Shelly app, for example 192.168.1.40.' },
        { title: 'Add the device', body: 'Enter the address (and password if it has one). MERLIN contacts the device and shows Connected only after it answers.' },
        { title: 'Add more devices', body: 'Repeat for each Shelly. Each one is checked separately.' },
      ],
      limitations: ['Disconnect removes every saved Shelly address and password from MERLIN. Shelly has no remote access to revoke.'],
    },
  },
  switchbot: {
    connector: 'switchbot',
    afterwards: 'MERLIN can list your SwitchBot devices and control plugs (on, off), curtains and blinds (open, close, position), humidifiers (on, off) and Bots (press), and lock a SwitchBot Lock.',
    remaining: 'Not yet supported: unlocking (MERLIN never unlocks doors), infrared remotes, cameras, lights, hub-less Bluetooth-only devices, and scenes. SwitchBot allows 10,000 requests per day.',
    setup: {
      description: 'Control SwitchBot plugs, curtains, blinds, humidifiers and Bots, and lock a SwitchBot Lock, through SwitchBot’s open API.',
      difficultyReason: 'Easy: two codes from the SwitchBot app, plus a SwitchBot Hub for remote control.',
      method: 'SwitchBot open API token and secret',
      requirements: ['A SwitchBot account with your devices added, and a SwitchBot Hub so devices can be reached over the internet.', 'SwitchBot app version 6.14 or newer.', 'Your open token and secret key from the app.'],
      steps: [
        { title: 'Open Developer Options', body: 'In the SwitchBot app open Profile, then Preferences. Tap App Version 10 times to reveal Developer Options.' },
        { title: 'Copy the token and secret', body: 'Choose Get Token and copy both the token and the secret key.' },
        { title: 'Enter them in the Connection Center', body: 'MERLIN asks SwitchBot for your device list and shows Connected only if the credentials are accepted.' },
      ],
      limitations: ['SwitchBot’s API is for personal use. Disconnect removes the codes from MERLIN; generate a new token in the app to invalidate the old one.'],
    },
  },
  rachio: {
    connector: 'rachio',
    afterwards: 'MERLIN can start a named zone for a number of minutes you give and stop all watering on a controller.',
    remaining: 'Not yet supported: Rachio Smart Hose Timers, schedules, rain delay, standby, and watering history. A started zone is reported as sent, not confirmed.',
    setup: {
      description: 'Run a Rachio sprinkler zone for a number of minutes, or stop all watering, on a Rachio controller.',
      difficultyReason: 'Easy: one API key copied from the Rachio app.',
      method: 'Rachio API key',
      requirements: ['A Rachio smart sprinkler controller on your account.', 'Your Rachio API key.'],
      steps: [
        { title: 'Copy your API key', body: 'In the Rachio app tap the Profile icon, choose API key, then Copy.' },
        { title: 'Enter it in the Connection Center', body: 'MERLIN asks Rachio for your controllers and zones and shows Connected only if the key works.' },
      ],
      limitations: ['Rachio allows 3,500 requests a day for a key.', 'A key can only be replaced in the Rachio app (Profile, API key, Get new key); Disconnect removes it from MERLIN.'],
    },
  },
};

/** Via Home Assistant: what MERLIN can do with the entities. `can` lists them; empty means nothing yet, with the reason. */
const VIA = {
  matter: { can: ['lights', 'switches', 'blinds', 'locks (lock only)', 'thermostats'], note: 'Home Assistant’s Matter support is the Matter controller; MERLIN has none of its own.' },
  mqtt: { can: ['lights', 'switches'], note: 'Only devices that announce themselves to Home Assistant over MQTT discovery appear.' },
  zigbee: { can: ['lights', 'switches'], note: 'Zigbee devices appear once paired in Home Assistant.' },
  'z-wave': { can: ['switches', 'locks (lock only)', 'thermostats'], note: 'Z-Wave devices appear once included in Home Assistant.' },
  'z-wave-thermostats': { can: ['thermostats'] },
  'tapo-kasa': { can: ['lights', 'switches'], note: 'TP-Link publishes no official API; Home Assistant’s integration relies on reverse-engineered local protocols, so features can change with firmware.' },
  sonos: { can: [], why: 'Sonos speakers appear in Home Assistant as media players, which MERLIN does not control yet. Use Spotify for music.' },
  'google-cast': { can: [], why: 'Cast devices appear as media players, which MERLIN does not control yet.' },
  'lg-webos': { can: [], why: 'TVs appear as media players, which MERLIN does not control yet.' },
  reolink: { can: [], why: 'Cameras appear as camera entities, which MERLIN cannot view or control yet.' },
  'rtsp-onvif': { can: [], why: 'Cameras appear as camera entities, which MERLIN cannot view or control yet.' },
  'lg-thinq': { can: ['air conditioners and other thermostats'], why: 'Washers, dryers and other appliances expose sensors and limited switches that MERLIN does not control.' },
  smarthq: { can: [], why: 'SmartHQ appliances mostly expose sensors and limited switches that MERLIN does not control.' },
  'home-connect': { can: [], why: 'Appliance programs, including oven heating, are not controlled by MERLIN.' },
  'samsung-smartthings': { can: ['lights', 'switches', 'locks (lock only)', 'thermostats'], note: 'SmartThings’ own personal access tokens last only 24 hours, so MERLIN does not connect to SmartThings directly. Use Home Assistant’s SmartThings integration instead.' },
  ring: { can: [], why: 'Ring cameras, doorbells and alarms appear as camera and alarm entities, which MERLIN cannot control. Ring publishes no public API for individual developers.' },
  'unifi-protect': { can: [], why: 'Cameras appear as camera entities, which MERLIN cannot view or control yet.' },
  lutron: { can: ['lights', 'switches', 'blinds'], note: 'Lutron Caséta’s local protocol requires pairing with the bridge in Home Assistant.' },
  aqara: { can: ['lights', 'switches', 'blinds', 'locks (lock only)'], note: 'What appears depends on whether you connect through Matter or a model-specific route.' },
  eve: { can: ['switches', 'blinds', 'thermostats'] },
  ikea: { can: ['lights', 'switches', 'blinds'] },
  ecobee: { can: ['thermostats'], note: 'Home Assistant’s ecobee integration now signs in with your ecobee account; no developer key is needed.' },
  'yale-august': { can: ['locks (lock only)'] },
  schlage: { can: ['locks (lock only)'] },
  roborock: { can: ['vacuums (start and stop)'] },
  irobot: { can: ['vacuums (start and stop)'] },
  levoit: { can: ['purifier and humidifier fans (on and off)'] },
  'rabbit-air': { can: ['purifier fans (on and off)'] },
  midea: { can: ['air conditioners and other thermostats'] },
  gree: { can: ['air conditioners and other thermostats'] },
  wallbox: { can: [], why: 'Charger controls are not part of MERLIN’s Home Assistant support yet.' },
  enphase: { can: [], why: 'Solar and battery data are read-only sensors that MERLIN does not read yet.' },
  ratgdo: { can: [], why: 'MERLIN never opens or closes garage doors, even through Home Assistant.' },
  'amazon-echo': { can: [], why: 'Echo devices appear as media players, which MERLIN does not control yet.' },
};

/** No route for MERLIN at all. */
const NONE = {
  'apple-home': 'Apple Home can only be reached from a native Apple app with HomeKit access, and MERLIN has none yet.',
  'google-home': 'Google’s Home APIs are restricted to approved partners and native apps. MERLIN has no access.',
  'google-home-mcp': 'Google’s Home MCP is early access and restricted. MERLIN has no access.',
  'apple-homepod': 'MERLIN has no AirPlay sender, so it cannot send audio to a HomePod.',
  eufy: 'eufy offers only a model-specific camera stream that MERLIN does not consume.',
  myq: 'Chamberlain blocked third-party access to myQ. No supported route exists.',
};

const sentence = list => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] ?? '');

/** The honest integration record for one catalog entry. */
export function integrationFor(entry) {
  if (NATIVE[entry.id]) {
    const { connector, afterwards, remaining } = NATIVE[entry.id];
    return { type: 'native', label: 'Connects to MERLIN', connector, afterwards, remaining, via: '' };
  }
  if (Object.hasOwn(NONE, entry.id)) {
    return { type: 'none', label: 'No supported route', connector: '', via: '', afterwards: 'MERLIN cannot control this today.', remaining: NONE[entry.id] };
  }
  const via = VIA[entry.id] ?? { can: [], why: 'MERLIN has no connector for this and Home Assistant exposes it in a form MERLIN does not control yet.' };
  const afterwards = via.can.length
    ? `After it works in Home Assistant and Home Assistant is connected to MERLIN, MERLIN can control the ${sentence(via.can)} that Home Assistant exposes for it. Following this guide does not connect anything to MERLIN by itself.`
    : `Even after it works in Home Assistant, MERLIN cannot control it yet. ${via.why} Following this guide does not connect anything to MERLIN by itself.`;
  const remaining = `MERLIN has no ${entry.name} connector of its own and reaches the device only through Home Assistant’s entities.${via.note ? ` ${via.note}` : ''}`;
  return { type: 'via-home-assistant', label: 'Through Home Assistant', connector: '', via: 'home-assistant', afterwards, remaining, can: [...via.can] };
}

/** Replacement setup copy for entries MERLIN connects to directly. */
export function nativeSetup(id) { return NATIVE[id]?.setup ?? null; }
export const NATIVE_CONNECTOR_IDS = Object.freeze(Object.keys(NATIVE).map(id => NATIVE[id].connector));
export const SPOTIFY_INTEGRATION = Object.freeze({ type: 'native', label: 'Connects to MERLIN', connector: 'spotify', via: '',
  afterwards: 'MERLIN can search Spotify, show your playlists, and play, pause, skip, change volume, shuffle, repeat, queue and move playback between your Spotify devices, by typing.',
  remaining: 'Not supported: voice control, music alarms, and reading Spotify content to the assistant (Spotify’s policy). Playback needs Spotify Premium and an open Spotify device.' });
