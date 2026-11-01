import { createHash, randomBytes } from 'node:crypto';
import { ConnectorError, cleanText, localHost, requestJson } from './base.js';

// Shelly Gen2+ devices over their documented local RPC HTTP API.
// https://shelly-api-docs.shelly.cloud/gen2/
//
// Several devices can be saved at once. Only second-generation and newer devices speak this API; first-generation
// devices are refused rather than guessed at. The username is always "admin"; the optional password uses the
// documented SHA-256 digest authentication (RFC 7616), so it is never sent in the clear.

const COMPONENT = /^(switch|light|cover):(\d+)$/u;
const KIND = { switch: 'switch', light: 'light', cover: 'cover' };
// A Shelly in cover mode can drive a garage door or gate. Nothing tells us which, so any cover whose name suggests
// one is read-only: MERLIN never moves doors people or cars pass through.
const RESTRICTED_NAME = /\b(?:garage|gate|door|portal|port[oó]n|overhead|barrier|shutter door)s?\b/iu;

const sha256 = text => createHash('sha256').update(text).digest('hex');
const unsupportedGeneration = host => new ConnectorError('unsupported', `The device at ${host} did not answer the Shelly Gen2+ API. First-generation Shelly devices are not supported by MERLIN.`);

function parseChallenge(header) {
  if (!/^\s*digest\s/iu.test(header)) return null;
  const fields = {};
  for (const match of header.replace(/^\s*digest\s+/iu, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/gu)) fields[match[1].toLowerCase()] = match[2] ?? match[3];
  if (!fields.nonce || !fields.realm) return null;
  if (fields.algorithm && !/^sha-?256$/iu.test(fields.algorithm)) return null;
  return { realm: fields.realm, nonce: fields.nonce, nc: 0 };
}

function digestHeader(password, challenge, uri) {
  challenge.nc += 1;
  const nc = challenge.nc.toString(16).padStart(8, '0');
  const cnonce = randomBytes(8).toString('hex');
  const ha1 = sha256(`admin:${challenge.realm}:${password}`);
  const ha2 = sha256(`GET:${uri}`);
  const response = sha256(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`);
  return `Digest username="admin", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", cnonce="${cnonce}", nc=${nc}, qop=auth, response="${response}", algorithm=SHA-256`;
}

/** A fetch that answers a Shelly digest challenge once. A second 401 is returned for the caller to treat as a wrong password. */
function digestFetch(device, nonces, baseFetch) {
  return async (url, options = {}) => {
    const { pathname, search } = new URL(url);
    const uri = `${pathname}${search}`;
    const signed = challenge => ({ ...options, headers: { ...options.headers, Authorization: digestHeader(device.password, challenge, uri) } });
    const known = nonces.get(device.host);
    // The documented nonce lifetime allows many requests; refresh well before the limit.
    const first = known && device.password && known.nc < 20_000 ? await baseFetch(url, signed(known)) : await baseFetch(url, options);
    if (first.status !== 401 || !device.password) return first;
    const fresh = parseChallenge(first.headers.get('www-authenticate') ?? '');
    if (!fresh) return first;
    nonces.set(device.host, fresh);
    return baseFetch(url, signed(fresh));
  };
}

const percentOf = value => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined);

function mapComponent(device, key, status, cfg, count) {
  const [, type, index] = key.match(COMPONENT);
  const base = cleanText(device.name || device.model || 'Shelly', 60);
  const own = cleanText(cfg?.name ?? '', 60);
  const name = own || (count > 1 ? `${base} ${Number(index) + 1}` : base);
  const common = { id: `${device.host}#${key}`, name, kind: KIND[type], ...(own && device.name && cleanText(device.name, 60) !== own ? { room: cleanText(device.name, 60) } : {}) };
  if (type === 'switch') return { ...common, state: { on: status.output === true }, actions: ['turn_on', 'turn_off', 'toggle'] };
  if (type === 'light') return { ...common, state: { on: status.output === true, brightness: percentOf(status.brightness) }, actions: ['turn_on', 'turn_off', 'toggle', 'set_brightness'] };
  const restricted = RESTRICTED_NAME.test(`${own} ${device.name ?? ''}`);
  const position = typeof status.current_pos === 'number' ? percentOf(status.current_pos) : undefined;
  return { ...common, state: { position, on: status.state === 'open' },
    actions: restricted ? [] : ['open', 'close', 'stop', ...(position !== undefined ? ['set_position'] : [])] };
}

/** Whether the component now reports what was asked. A cover that is still moving is not confirmed. */
function confirms(type, status, action, value, before) {
  if (type === 'cover') {
    switch (action) {
      case 'open': return status.state === 'open';
      case 'close': return status.state === 'closed';
      case 'stop': return ['stopped', 'open', 'closed'].includes(status.state);
      case 'set_position': return typeof status.current_pos === 'number' && Math.abs(status.current_pos - value) <= 2;
      default: return false;
    }
  }
  switch (action) {
    case 'turn_on': return status.output === true;
    case 'turn_off': return status.output === false;
    case 'toggle': return typeof before === 'boolean' && status.output === !before;
    case 'set_brightness': return value === 0 ? status.output === false : status.output === true && Math.abs(Number(status.brightness) - value) <= 2;
    default: return false;
  }
}

const RPC = {
  switch: { turn_on: ['Switch.Set', { on: true }], turn_off: ['Switch.Set', { on: false }], toggle: ['Switch.Toggle', {}] },
  light: { turn_on: ['Light.Set', { on: true }], turn_off: ['Light.Set', { on: false }], toggle: ['Light.Toggle', {}] },
  cover: { open: ['Cover.Open', {}], close: ['Cover.Close', {}], stop: ['Cover.Stop', {}] },
};

export function shelly() {
  // Digest nonces are kept per connector instance, never persisted.
  const nonces = new Map();

  const rpc = async (device, method, params, ctx) => {
    const query = params && Object.keys(params).length ? `?${new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))}` : '';
    try {
      const { data } = await requestJson(`http://${device.host}/rpc/${method}${query}`, {
        service: `The Shelly at ${device.host}`, signal: ctx.signal, fetch: digestFetch(device, nonces, ctx.fetch),
      });
      return data;
    } catch (error) {
      if (error instanceof ConnectorError && error.kind === 'auth') {
        throw new ConnectorError('auth', `The Shelly at ${device.host} rejected the saved password. Check it in the Shelly’s web page and reconnect it.`);
      }
      throw error;
    }
  };

  const find = (config, id) => {
    const host = String(id).split('#')[0];
    const device = config.devices.find(item => item.host === host);
    if (!device) throw new ConnectorError('device', 'That Shelly is no longer saved in MERLIN.');
    return device;
  };

  async function describeDevice(host, password, ctx) {
    let info;
    try { info = await rpc({ host }, 'Shelly.GetDeviceInfo', null, ctx); }
    catch (error) { if (error instanceof ConnectorError && ['device', 'failed'].includes(error.kind)) throw unsupportedGeneration(host); throw error; }
    if (!info || typeof info !== 'object' || !Number.isFinite(info.gen) || info.gen < 2 || typeof info.id !== 'string') throw unsupportedGeneration(host);
    if (info.auth_en && !password) throw new ConnectorError('invalid', 'This Shelly has a password; enter it.');
    // Only a device that really has a password keeps one on file.
    const entry = { host, id: cleanText(info.id, 60), name: cleanText(info.name || '', 60), model: cleanText(info.model || info.app || 'Shelly', 40), gen: info.gen, auth: info.auth_en === true, ...(info.auth_en ? { password } : {}) };
    const status = await rpc(entry, 'Shelly.GetStatus', null, ctx);
    const components = Object.keys(status ?? {}).filter(key => COMPONENT.test(key));
    if (!components.length) throw new ConnectorError('unsupported', 'This Shelly has no switch, light or cover that MERLIN can control. Sensors and inputs are not supported.');
    return entry;
  }

  return {
    id: 'shelly',
    name: 'Shelly',
    summary: 'Switch Shelly relays and plugs, dim Shelly lights and move Shelly covers over your home network (second-generation and newer devices).',
    kinds: ['switch', 'light', 'cover'],
    fields: [
      { name: 'host', label: 'Shelly address', type: 'text', placeholder: '192.168.1.20', help: 'The IP address of the Shelly on your home network, shown in your router or the Shelly app. Add each Shelly one at a time.' },
      { name: 'password', label: 'Shelly password', type: 'secret', required: false, placeholder: 'Only if you set one', help: 'Leave blank unless you turned on authentication for this Shelly. The user name is always admin.' },
    ],
    publicConfig: config => ({ devices: (config.devices ?? []).map(({ host, name, model }) => ({ host, name, model })) }),

    async connect(input, current, ctx) {
      const host = localHost(input.host);
      const saved = current?.devices ?? [];
      const password = input.password || saved.find(device => device.host === host)?.password || '';
      const entry = await describeDevice(host, password, ctx);
      const devices = [...saved.filter(device => device.host !== host && device.id !== entry.id), entry];
      return { config: { devices }, summary: `Connected ${entry.name || entry.model} (${entry.model}). ${devices.length} Shelly device${devices.length === 1 ? '' : 's'} saved.` };
    },

    async verify(config, ctx) {
      const results = await Promise.allSettled(config.devices.map(device => rpc(device, 'Shelly.GetStatus', null, ctx)));
      const failed = results.map((result, index) => ({ result, device: config.devices[index] })).filter(item => item.result.status === 'rejected');
      if (failed.length === results.length) throw (failed.find(item => item.result.reason?.kind === 'auth') ?? failed[0]).result.reason;
      const offline = failed.map(item => item.device.name || item.device.host);
      return { summary: `${results.length - failed.length} of ${results.length} Shelly devices answered.${offline.length ? ` Not answering: ${offline.join(', ')}.` : ''}` };
    },

    async devices(config, ctx) {
      const results = await Promise.allSettled(config.devices.map(async device => {
        const [status, settings] = await Promise.all([rpc(device, 'Shelly.GetStatus', null, ctx), rpc(device, 'Shelly.GetConfig', null, ctx)]);
        const keys = Object.keys(status ?? {}).filter(key => COMPONENT.test(key));
        const counts = Object.fromEntries(Object.keys(KIND).map(type => [type, keys.filter(key => key.startsWith(`${type}:`)).length]));
        return keys.map(key => mapComponent(device, key, status[key] ?? {}, settings?.[key], counts[key.split(':')[0]]));
      }));
      const failures = results.filter(result => result.status === 'rejected');
      // One device being off does not hide the others; all of them failing is a real problem.
      if (failures.length && failures.length === results.length) throw (failures.find(item => item.reason?.kind === 'auth') ?? failures[0]).reason;
      return results.filter(result => result.status === 'fulfilled').flatMap(result => result.value);
    },

    async state(config, device, ctx) {
      const owner = find(config, device.id);
      const key = device.id.split('#')[1];
      const [type, index] = key.split(':');
      const status = await rpc(owner, `${type[0].toUpperCase()}${type.slice(1)}.GetStatus`, { id: index }, ctx);
      return mapComponent(owner, key, status ?? {}, { name: device.name }, 1).state;
    },

    async act(config, device, action, value, ctx) {
      const owner = find(config, device.id);
      const key = device.id.split('#')[1];
      const [type, index] = key.split(':');
      const component = `${type[0].toUpperCase()}${type.slice(1)}`;
      let method; let params;
      if (action === 'set_brightness') {
        [method, params] = value === 0 ? ['Light.Set', { on: false }] : ['Light.Set', { on: true, brightness: value }];
      } else if (action === 'set_position') {
        [method, params] = ['Cover.GoToPosition', { pos: value }];
      } else if (RPC[type]?.[action]) {
        [method, params] = RPC[type][action];
      } else throw new ConnectorError('unsupported', `${device.name} can’t do that through MERLIN.`);
      const response = await rpc(owner, method, { id: index, ...params }, ctx);
      await ctx.sleep?.(type === 'cover' ? 800 : 200);
      try {
        const status = await rpc(owner, `${component}.GetStatus`, { id: index }, ctx);
        return { confirmed: confirms(type, status ?? {}, action, value, response?.was_on) };
      } catch { return { confirmed: false }; }
    },

    operations: {
      remove: {
        // Dropping one device edits the saved list; it does not re-verify the rest.
        keeps: true,
        label: 'Remove one Shelly', needs: 'saved',
        fields: [{ name: 'host', label: 'Address', type: 'text' }],
        async run(config, input) {
          const host = localHost(input.host);
          const devices = config?.devices ?? [];
          if (!devices.some(device => device.host === host)) throw new ConnectorError('invalid', 'That Shelly is not saved.');
          if (devices.length === 1) throw new ConnectorError('invalid', 'Use Disconnect to remove the last Shelly.');
          return { config: { devices: devices.filter(device => device.host !== host) }, summary: `Removed the Shelly at ${host}.` };
        },
      },
    },

    async disconnect() {
      return { revoked: false, message: 'Shelly has no remote access to revoke. MERLIN forgot the saved addresses and passwords. If you want to stop the device accepting commands, set or change its password in the Shelly web page.' };
    },
  };
}
