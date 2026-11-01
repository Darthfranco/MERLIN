import { createHmac, randomUUID } from 'node:crypto';
import { ConnectorError, cleanText, displayName, requestJson } from './base.js';

// SwitchBot Open API v1.1 with the account's open token and secret key.
// https://github.com/OpenWonderLabs/SwitchBotAPI
//
// Commands are relayed through a SwitchBot hub (or the device's own Wi-Fi) and are asynchronous, so a command is only
// reported as confirmed when a follow-up status read shows the requested result. The API allows 10,000 calls a day,
// so MERLIN makes one list call (the hub caches it) and at most one status call per command or state read.
// IR remotes, cameras, lights, vacuums, fans and sensors are not exposed yet. MERLIN locks doors and never unlocks them.

const BASE = 'https://api.switch-bot.com';
const SERVICE = 'SwitchBot';
const SETTLE_MS = 1500;
const ID = /^[A-Za-z0-9_-]{1,64}$/u;
// Defence in depth: none of these appears in any command table, and none may ever be sent.
const NEVER_SEND = new Set(['unlock', 'deadbolt', 'nightLatchUnlock', 'createKey', 'deleteKey']);

/** The one place the request signature is built: base64(HMAC-SHA256(secret, token + t + nonce)), upper-cased. */
export const signature = (token, secret, t, nonce) => createHmac('sha256', secret).update(`${token}${t}${nonce}`).digest('base64').toUpperCase();

// Command tables are taken from the official per-device documents (devices/**/*.md in the API repository).
// SwitchBot reports covers with 0 = open and 100 = closed (Blind Tilt: 0 = closed). MERLIN uses 100 = fully open.
const setPosition = (parameter) => (value) => ['setPosition', parameter(value)];
const FAMILIES = {
  plug: { kind: 'switch', on: 'power', commands: { turn_on: ['turnOn', 'default'], turn_off: ['turnOff', 'default'] } },
  plugMini: { kind: 'switch', on: 'plug-mini', commands: { turn_on: ['turnOn', 'default'], turn_off: ['turnOff', 'default'], toggle: ['toggle', 'default'] } },
  curtain: { kind: 'cover', invert: true, commands: {
    open: ['turnOn', 'default'], close: ['turnOff', 'default'], stop: ['pause', 'default'], set_position: setPosition(value => `0,ff,${100 - value}`) } },
  rollerShade: { kind: 'cover', invert: true, commands: {
    open: ['setPosition', '0'], close: ['setPosition', '100'], set_position: setPosition(value => String(100 - value)) } },
  // Blind Tilt moves slats, not a position, and its position must be a multiple of 2 with a direction: only open and close.
  blindTilt: { kind: 'cover', invert: false, commands: { open: ['fullyOpen', 'default'], close: ['closeUp', 'default'] } },
  lock: { kind: 'lock', commands: { lock: ['lock', 'default'] } },
  humidifier: { kind: 'humidifier', on: 'power', commands: { turn_on: ['turnOn', 'default'], turn_off: ['turnOff', 'default'] } },
  bot: { kind: 'button', commands: { press: ['press', 'default'] } },
};
const TYPE_FAMILY = {
  plug: 'plug', plugminius: 'plugMini', plugminijp: 'plugMini', plugminieu: 'plugMini',
  curtain: 'curtain', curtain3: 'curtain', rollershade: 'rollerShade', blindtilt: 'blindTilt',
  lock: 'lock', smartlock: 'lock', lockpro: 'lock', smartlockpro: 'lock', smartlockprowifi: 'lock', locklite: 'lock', lockultra: 'lock', lockvision: 'lock', lockvisionpro: 'lock',
  humidifier: 'humidifier', humidifier2: 'humidifier', evaporativehumidifier: 'humidifier', evaporativehumidifierautorefill: 'humidifier',
  bot: 'bot',
};
const familyOf = deviceType => TYPE_FAMILY[String(deviceType ?? '').toLowerCase().replace(/[^a-z0-9]/gu, '')] ?? null;

function call(config, path, ctx, { method = 'GET', body, device } = {}) {
  const t = String(ctx.clock?.() ?? Date.now());
  const nonce = ctx.nonce?.() ?? randomUUID();
  return requestJson(`${BASE}${path}`, {
    service: SERVICE, method, body, signal: ctx.signal, fetch: ctx.fetch,
    headers: { Authorization: config.token, t, nonce, sign: signature(config.token, config.secret, t, nonce), ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf8' }) },
  }).then(({ data }) => unwrap(data, device), error => {
    // SwitchBot also answers "Unauthorized" once the 10,000-calls-a-day limit is used up.
    if (error instanceof ConnectorError && error.kind === 'auth') {
      throw new ConnectorError('auth', 'SwitchBot rejected the saved token or secret. Check both in the SwitchBot app (it also answers this way after 10,000 requests in a day).');
    }
    throw error;
  });
}

/** SwitchBot answers HTTP 200 with its own statusCode in the body. 100 means success. */
function unwrap(data, device) {
  const code = data?.statusCode;
  if (code === 100) return data.body ?? {};
  const who = cleanText(device?.name || 'That device', 60);
  if (code === 151 || code === 152) throw new ConnectorError('device', `SwitchBot does not recognise ${who} for that request. It may have been removed or changed.`);
  if (code === 160) throw new ConnectorError('unsupported', `${who} does not support that command.`);
  if (code === 161) throw new ConnectorError('unreachable', `${who} is offline in SwitchBot. Check its power, Bluetooth range and hub.`);
  if (code === 171) throw new ConnectorError('unreachable', `${who}’s SwitchBot hub is offline. Check the hub’s power and Wi-Fi.`);
  throw new ConnectorError('failed', `SwitchBot could not complete that${Number.isInteger(code) ? ` (code ${code})` : ''}.`);
}

function mapDevice(entry) {
  const family = familyOf(entry?.deviceType);
  if (!family || typeof entry.deviceId !== 'string' || !ID.test(entry.deviceId)) return null;
  const spec = FAMILIES[family];
  const cloud = entry.enableCloudService !== false;
  return {
    id: entry.deviceId, name: displayName(entry.deviceName, spec.kind), kind: spec.kind,
    state: cloud ? {} : { reachable: false },
    // A device with cloud control switched off can be seen but not commanded.
    actions: cloud ? Object.keys(spec.commands) : [], extra: { family },
  };
}

const lowered = value => (typeof value === 'string' ? value.toLowerCase() : '');
function isOn(spec, status) {
  if (spec.on === 'power' || spec.on === 'plug-mini') {
    // Plug (and the humidifiers) report power as ON/OFF. The EU Plug Mini reports switchStatus 0/1, and its `power` is watts.
    if (['on', 'off'].includes(lowered(status.power))) return lowered(status.power) === 'on';
    if (status.switchStatus === 0 || status.switchStatus === 1) return status.switchStatus === 1;
  }
  return undefined;
}
const isLocked = status => ['lock', 'locked', 'latchboltlocked'].includes(lowered(status.lockState));

function stateFrom(family, status, device) {
  const spec = FAMILIES[family];
  if (spec.kind === 'cover') {
    const slide = Number(status.slidePosition);
    if (!Number.isFinite(slide)) return { running: status.moving === true };
    const position = Math.round(spec.invert ? 100 - slide : slide);
    return { position, on: position > 0, running: status.moving === true };
  }
  if (spec.kind === 'lock') {
    if (lowered(status.lockState) === 'jammed') throw new ConnectorError('device', `${device?.name ?? 'The lock'} reports that it is jammed. Check it in person.`);
    return { locked: isLocked(status) };
  }
  const on = isOn(spec, status);
  return on === undefined ? {} : { on };
}

function confirms(family, action, value, status) {
  const spec = FAMILIES[family];
  if (spec.kind === 'cover') {
    const state = stateFrom(family, status);
    if (state.position === undefined) return false;
    if (action === 'stop') return state.running === false;
    const target = action === 'open' ? 100 : action === 'close' ? 0 : value;
    return state.running !== true && Math.abs(state.position - target) <= 3;
  }
  if (spec.kind === 'lock') return action === 'lock' && isLocked(status);
  const on = isOn(spec, status);
  return on !== undefined && ((action === 'turn_on' && on) || (action === 'turn_off' && !on));
}

const statusOf = (config, device, ctx) => call(config, `/v1.1/devices/${encodeURIComponent(device.id)}/status`, ctx, { device });

async function summarise(config, ctx) {
  const body = await call(config, '/v1.1/devices', ctx);
  if (!Array.isArray(body.deviceList)) throw new ConnectorError('failed', 'SwitchBot sent a device list MERLIN could not read.');
  const usable = body.deviceList.map(mapDevice).filter(Boolean);
  return { devices: usable, count: usable.length, controllable: usable.filter(device => device.actions.length).length };
}

const describe = ({ count, controllable }) => count
  ? `SwitchBot accepted the token. MERLIN can use ${count} device${count === 1 ? '' : 's'} (plugs, curtains, blinds, shades, locks, humidifiers and Bots)${controllable < count ? `; ${count - controllable} without cloud control can only be read` : ''}. IR remotes, cameras and lights are not supported yet.`
  : 'SwitchBot accepted the token, but no plugs, curtains, blinds, shades, locks, humidifiers or Bots were found. Devices need to be added to the SwitchBot app with Cloud Services on through a hub.';

export function switchbot() {
  return {
    id: 'switchbot',
    name: 'SwitchBot',
    summary: 'Turn SwitchBot plugs, humidifiers and Bots on or off, open or close curtains, blinds and shades, and lock SwitchBot locks. Locks are never unlocked by MERLIN.',
    kinds: ['switch', 'cover', 'lock', 'humidifier', 'button'],
    cacheMs: 60_000,
    fields: [
      { name: 'token', label: 'Open token', type: 'secret', placeholder: 'Paste the token', help: 'In the SwitchBot app open Profile, Preferences, About, tap App Version ten times, then Developer Options and Get Token (app 6.14 or newer).' },
      { name: 'secret', label: 'Secret key', type: 'secret', placeholder: 'Paste the secret key', help: 'Shown on the same Developer Options screen as the token.' },
    ],
    publicConfig: config => (Number.isInteger(config.device_count) ? { devices: config.device_count } : {}),

    async connect(input, current, ctx) {
      let token = input.token, secret = input.secret;
      if (!token && !secret && current?.token && current?.secret) ({ token, secret } = current);
      if (!token || !secret) throw new ConnectorError('invalid', 'Paste both the open token and the secret key from the SwitchBot app.');
      const config = { token, secret };
      const found = await summarise(config, ctx);
      return { config: { ...config, device_count: found.count }, summary: describe(found) };
    },

    async verify(config, ctx) {
      const found = await summarise(config, ctx);
      return { config: { ...config, device_count: found.count }, summary: describe(found) };
    },

    async devices(config, ctx) { return (await summarise(config, ctx)).devices; },

    async state(config, device, ctx) {
      const family = device.extra?.family;
      if (!FAMILIES[family] || FAMILIES[family].kind === 'button') return {};
      return stateFrom(family, await statusOf(config, device, ctx), device);
    },

    async act(config, device, action, value, ctx) {
      const family = device.extra?.family;
      const entry = FAMILIES[family]?.commands[action];
      // A device with cloud control off lists no actions even though its model has commands.
      if (!entry || !device.actions?.includes(action)) throw new ConnectorError('unsupported', `${device.name} can’t do that through MERLIN.`);
      const [command, parameter] = typeof entry === 'function' ? entry(value) : entry;
      if (NEVER_SEND.has(command)) throw new ConnectorError('unsupported', 'MERLIN never unlocks doors.');
      await call(config, `/v1.1/devices/${encodeURIComponent(device.id)}/commands`, ctx, { method: 'POST', body: { command, parameter, commandType: 'command' }, device });
      // A press or a toggle has no state to compare with; asking would only spend the daily allowance.
      if (action === 'press' || action === 'toggle') return { confirmed: false };
      await ctx.sleep?.(SETTLE_MS);
      try { return { confirmed: confirms(family, action, value, await statusOf(config, device, ctx)) }; }
      catch { return { confirmed: false }; }
    },

    async disconnect() {
      return { revoked: false, message: 'SwitchBot cannot revoke the token from outside the app. To finish, open Developer Options in the SwitchBot app and choose Get Token again, which creates a new token and secret and stops the old ones working.' };
    },
  };
}
