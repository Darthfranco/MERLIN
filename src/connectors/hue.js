import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { ConnectorError, cleanText, localHost, requestJson } from './base.js';

// Philips Hue Bridge, local API v2 (CLIP), with an application key created by pressing the bridge's link button.
// https://developers.meethue.com/develop/hue-api-v2/getting-started/
//
// The bridge presents a certificate from Signify's private CA, so it cannot be verified like a public site. MERLIN
// pins the certificate's SHA-256 fingerprint the first time it talks to the bridge (trust on first use) and refuses to
// send the application key to anything that presents a different certificate.

const PAIR_PROMPT = 'Press the round link button on top of the bridge, then choose Pair within 30 seconds.';
const LINK_BUTTON = 'The link button was not pressed. Press it and choose Pair again within 30 seconds.';
const CERT_CHANGED = 'The security certificate of the device at this address changed, so MERLIN stopped talking to it. If you reset your Hue Bridge, disconnect Philips Hue and set it up again; otherwise treat this as an unknown device.';
const NOT_REVOKED = 'The bridge did not confirm removing MERLIN’s key, so it may still be allowed to control your lights. Remove MERLIN in the Hue app (Settings > My Hue system / bridge settings).';
const MAX_BYTES = 4_000_000;
const MIREK = { min: 153, max: 500 };
const KEY = /^[A-Za-z0-9_-]{16,80}$/u;
const FINGERPRINT = /^[a-f0-9]{64}$/u;

const fingerprintOf = certificate => {
  const raw = certificate?.raw;
  if (Buffer.isBuffer(raw)) return createHash('sha256').update(raw).digest('hex');
  return String(certificate?.fingerprint256 ?? '').toLowerCase().replace(/[^a-f0-9]/gu, '');
};

/**
 * HTTPS to a bridge with a self-signed certificate. The TLS handshake is finished and the certificate checked against
 * the pin BEFORE any request bytes (and so the application key) are written to the socket.
 * Returns {status, headers, text, fingerprint}. A pin mismatch rejects with code HUE_PIN_MISMATCH.
 */
export function hueTransport({ url, method = 'GET', headers = {}, body, signal, pin = null, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const port = Number(target.port || 443);
    let settled = false;
    let socket;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      settle(value);
    };
    const fail = error => { socket?.destroy(); finish(reject, error); };
    const onAbort = () => fail(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const timer = setTimeout(() => fail(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    socket = tls.connect({ host: target.hostname, port, rejectUnauthorized: false, ...(net.isIP(target.hostname) ? {} : { servername: target.hostname }) });
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      const fingerprint = fingerprintOf(socket.getPeerCertificate());
      if (!fingerprint || (pin && fingerprint !== pin)) { fail(Object.assign(new Error('certificate changed'), { code: 'HUE_PIN_MISMATCH' })); return; }
      const payload = body === undefined ? undefined : Buffer.from(body);
      const request = http.request({
        createConnection: () => socket, host: target.hostname, port, path: `${target.pathname}${target.search}`, method,
        headers: { ...headers, host: target.host, connection: 'close', ...(payload ? { 'content-length': payload.length } : {}) },
      }, response => {
        const chunks = [];
        let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > MAX_BYTES) fail(new Error('response too large')); else chunks.push(chunk); });
        response.on('end', () => finish(resolve, { status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8'), fingerprint }));
        response.on('error', fail);
      });
      request.on('error', fail);
      request.end(payload);
    });
  });
}

/** One bridge request: pin enforced, redirects refused, errors mapped like every other connector. */
async function call(config, path, ctx, { method = 'GET', body, authenticated = true, pin = config.fingerprint ?? null } = {}) {
  const send = ctx.hueRequest ?? hueTransport;
  let mismatch = false;
  let fingerprint = null;
  const adapter = async (url, options) => {
    let response;
    try { response = await send({ url, method: options.method, headers: options.headers, body: options.body, signal: options.signal, pin }); }
    catch (error) { if (error?.code === 'HUE_PIN_MISMATCH') mismatch = true; throw error; }
    fingerprint = String(response.fingerprint ?? '').toLowerCase().replace(/[^a-f0-9]/gu, '');
    if (pin && fingerprint !== pin) { mismatch = true; throw new Error('certificate changed'); }
    const headers = Object.fromEntries(Object.entries(response.headers ?? {}).filter(([, value]) => typeof value === 'string'));
    return new Response([204, 205].includes(response.status) ? null : response.text, { status: response.status, headers });
  };
  try {
    const result = await requestJson(`https://${config.bridge}${path}`, {
      service: 'Philips Hue', method, body, signal: ctx.signal, fetch: adapter, maxBytes: MAX_BYTES,
      headers: authenticated ? { 'hue-application-key': config.app_key ?? '' } : {},
    });
    return { data: result.data, fingerprint };
  } catch (error) {
    if (mismatch) throw new ConnectorError('auth', CERT_CHANGED);
    if (authenticated && error instanceof ConnectorError && error.kind === 'auth') {
      throw new ConnectorError('auth', 'Your Hue Bridge no longer accepts MERLIN’s key. Disconnect Philips Hue and pair again.');
    }
    throw error;
  }
}

/** The v2 envelope is {errors, data}; any error means the change did not happen. */
function unwrap(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ConnectorError('failed', 'Philips Hue sent a response MERLIN could not read.');
  if (Array.isArray(data.errors) && data.errors.length) {
    throw new ConnectorError('failed', `Philips Hue reported a problem: ${cleanText(data.errors[0]?.description, 100) || 'the change was refused'}.`);
  }
  return Array.isArray(data.data) ? data.data : [];
}

const list = async (config, type, ctx) => unwrap((await call(config, `/clip/v2/resource/${type}`, ctx)).data);

async function checkAccess(config, ctx) {
  if (!config?.app_key) throw new ConnectorError('invalid', 'Pairing with the bridge is not finished yet.');
  try {
    const bridges = await list(config, 'bridge', ctx);
    if (!bridges.length) throw new ConnectorError('failed', 'The bridge answered but did not identify itself.');
  } catch (error) {
    if (error instanceof ConnectorError && error.kind === 'device') throw new ConnectorError('unsupported', 'This bridge does not offer the Hue v2 API MERLIN needs. Use a current Hue Bridge (the square one) with up-to-date software.');
    throw error;
  }
}

/** Best effort: remove an application key from the bridge's whitelist (v1 endpoint). */
async function revokeKey(config, key, ctx) {
  try {
    const { data } = await call(config, `/api/${encodeURIComponent(key)}/config/whitelist/${encodeURIComponent(key)}`, ctx, { method: 'DELETE', authenticated: false });
    return Array.isArray(data) && Boolean(data[0]?.success);
  } catch { return false; }
}

const mirekFor = (kelvin, range = MIREK) => Math.min(range.max, Math.max(range.min, Math.round(1_000_000 / kelvin)));
const brightness = resource => (typeof resource?.dimming?.brightness === 'number' ? Math.round(resource.dimming.brightness) : undefined);

function stateOf(resource, reachable) {
  const state = { on: resource?.on?.on === true, brightness: resource?.on?.on === true ? brightness(resource) : undefined };
  if (reachable !== undefined) state.reachable = reachable;
  return state;
}

function bodyFor(device, action, value) {
  if (device.kind === 'scene' && action === 'activate') return { recall: { action: 'active' } };
  if (device.kind === 'light' || device.kind === 'room') {
    switch (action) {
      case 'turn_on': return { on: { on: true } };
      case 'turn_off': return { on: { on: false } };
      // Hue ignores brightness for a light that is off, so a level request also turns it on.
      case 'set_brightness': return value === 0 ? { on: { on: false } } : { on: { on: true }, dimming: { brightness: value } };
      case 'set_color_temperature': if (device.kind === 'light') return { on: { on: true }, color_temperature: { mirek: mirekFor(value, device.extra?.mirek) } }; break;
      default:
    }
  }
  throw new ConnectorError('unsupported', `${device.name} can’t do that through MERLIN.`);
}

const resourcePath = device => `/clip/v2/resource/${device.kind === 'room' ? 'grouped_light' : device.kind}/${encodeURIComponent(device.id)}`;

/** Whether the resource now reports what was asked. Anything else is only "accepted". */
function confirms(resource, action, value, device) {
  const on = resource?.on?.on;
  switch (action) {
    case 'turn_on': return on === true;
    case 'turn_off': return on === false;
    case 'set_brightness': return value === 0 ? on === false : on === true && Math.abs((resource?.dimming?.brightness ?? -100) - value) <= (device.kind === 'room' ? 5 : 3);
    case 'set_color_temperature': return on === true && Math.abs((resource?.color_temperature?.mirek ?? -100) - mirekFor(value, device.extra?.mirek)) <= 3;
    default: return false;
  }
}

const bridgeConfig = (bridge, info, fingerprint) => ({
  bridge, name: cleanText(info.name || 'Philips Hue', 60), bridge_id: cleanText(info.bridgeid, 32).toLowerCase(),
  model: cleanText(info.modelid || '', 20), fingerprint,
});

/** `transport` replaces the HTTPS client (tests, or a platform with its own); the default pins the bridge certificate. */
export function philipsHue({ transport } = {}) {
  const using = ctx => (ctx.hueRequest || !transport ? ctx : { ...ctx, hueRequest: transport });
  return {
    id: 'philips-hue',
    name: 'Philips Hue',
    summary: 'Turn Hue lights and rooms on and off, set brightness and warmth, and recall scenes through your Hue Bridge on your home network.',
    kinds: ['light', 'room', 'scene'],
    fields: [
      { name: 'bridge', label: 'Hue Bridge address', type: 'text', placeholder: '192.168.1.50', help: 'The bridge’s address on your home network (in your router’s device list, or use Find my bridge). Setup has two steps: save the address, then press the bridge’s link button and choose Pair.' },
    ],
    publicConfig: config => ({ bridge: config.bridge, name: config.name }),

    async connect(input, current, ctx) {
      ctx = using(ctx);
      const bridge = localHost(input.bridge ?? current?.bridge);
      const same = current?.bridge === bridge;
      const pin = same ? current.fingerprint ?? null : null;
      const { data, fingerprint } = await call({ bridge }, '/api/config', ctx, { authenticated: false, pin });
      if (!data || typeof data !== 'object' || typeof data.bridgeid !== 'string' || !data.bridgeid.trim()) {
        throw new ConnectorError('failed', 'That address answered, but it does not look like a Hue Bridge.');
      }
      if (!FINGERPRINT.test(fingerprint ?? '')) throw new ConnectorError('failed', 'The bridge did not present a security certificate MERLIN can pin.');
      const config = bridgeConfig(bridge, data, pin ?? fingerprint);
      if (same && current.bridge_id && current.bridge_id !== config.bridge_id) throw new ConnectorError('auth', CERT_CHANGED);
      if (same && current.app_key) {
        // Already paired with this bridge: prove the saved key still works instead of asking to pair again.
        const paired = { ...config, app_key: current.app_key };
        try { await checkAccess(paired, ctx); return { config: paired, summary: `Connected to ${paired.name}.` }; }
        catch (error) { if (!(error instanceof ConnectorError) || error.kind !== 'auth') throw error; }
      }
      return { config, pending: PAIR_PROMPT };
    },

    async verify(config, ctx) {
      ctx = using(ctx);
      await checkAccess(config, ctx);
      return { summary: `${config.name} accepted MERLIN’s key.` };
    },

    operations: {
      pair: {
        label: 'Pair with the bridge',
        needs: 'saved',
        async run(config, _input, ctx) {
          ctx = using(ctx);
          if (!config?.bridge) throw new ConnectorError('invalid', 'Save the bridge address first.');
          const { data } = await call(config, '/api', ctx, { method: 'POST', authenticated: false, body: { devicetype: 'merlin#home', generateclientkey: true } });
          const first = Array.isArray(data) ? data[0] : null;
          if (first?.error?.type === 101) throw new ConnectorError('invalid', LINK_BUTTON);
          if (first?.error) throw new ConnectorError('failed', 'The bridge would not pair with MERLIN.');
          const key = first?.success?.username;
          if (typeof key !== 'string' || !KEY.test(key)) throw new ConnectorError('failed', 'The bridge did not give MERLIN a usable key.');
          // The optional client key is for streaming entertainment, which MERLIN does not use, so it is not kept.
          const next = { ...config, app_key: key };
          try { await checkAccess(next, ctx); }
          catch (error) { await revokeKey(next, key, ctx); throw error; }
          // Re-pairing replaces the old key; remove it so the bridge's limited key list does not fill up.
          if (config.app_key && config.app_key !== key) await revokeKey(next, config.app_key, ctx);
          return { config: next, summary: `Paired with ${next.name}.` };
        },
      },
      discover: {
        label: 'Find my bridge (asks Signify’s discovery service, which sees your public IP address)',
        needs: 'any',
        async run(_config, _input, ctx) {
          const { data } = await requestJson('https://discovery.meethue.com', { service: 'Hue discovery', fetch: ctx.fetch, signal: ctx.signal });
          const found = (Array.isArray(data) ? data : []).flatMap(item => {
            try { return [{ id: cleanText(item?.id, 40), ip: localHost(item?.internalipaddress) }]; } catch { return []; }
          }).slice(0, 5);
          return { result: found, summary: found.length ? `Found ${found.length} bridge${found.length === 1 ? '' : 's'}: ${found.map(item => item.ip).join(', ')}.` : 'No bridge was found. Enter its address by hand.' };
        },
      },
    },

    async devices(config, ctx) {
      ctx = using(ctx);
      const optional = list(config, 'zigbee_connectivity', ctx).catch(error => { if (error?.kind === 'auth') throw error; return []; });
      const [lights, rooms, scenes, groups, connectivity] = await Promise.all([
        list(config, 'light', ctx), list(config, 'room', ctx), list(config, 'scene', ctx), list(config, 'grouped_light', ctx), optional,
      ]);
      const roomOfDevice = new Map();
      const roomById = new Map();
      for (const room of rooms) {
        const name = cleanText(room.metadata?.name, 80);
        roomById.set(room.id, name);
        for (const child of Array.isArray(room.children) ? room.children : []) if (child?.rtype === 'device') roomOfDevice.set(child.rid, name);
      }
      const groupById = new Map(groups.map(group => [group.id, group]));
      const reachable = new Map(connectivity.map(item => [item.owner?.rid, item.status === 'connected']));
      const devices = [];
      for (const light of lights) {
        const range = light.color_temperature?.mirek_schema;
        devices.push({
          id: light.id, name: light.metadata?.name, kind: 'light', room: roomOfDevice.get(light.owner?.rid),
          state: stateOf(light, reachable.get(light.owner?.rid)),
          actions: ['turn_on', 'turn_off', ...(light.dimming ? ['set_brightness'] : []), ...(light.color_temperature ? ['set_color_temperature'] : [])],
          extra: { mirek: { min: Number(range?.mirek_minimum) || MIREK.min, max: Number(range?.mirek_maximum) || MIREK.max } },
        });
      }
      for (const room of rooms) {
        const groupId = (Array.isArray(room.services) ? room.services : []).find(service => service?.rtype === 'grouped_light')?.rid;
        if (!groupId) continue;
        const group = groupById.get(groupId);
        devices.push({ id: groupId, name: room.metadata?.name, kind: 'room', state: stateOf(group), actions: ['turn_on', 'turn_off', ...(group?.dimming ? ['set_brightness'] : [])] });
      }
      for (const scene of scenes) {
        devices.push({ id: scene.id, name: scene.metadata?.name, kind: 'scene', room: scene.group?.rtype === 'room' ? roomById.get(scene.group.rid) : undefined, state: {}, actions: ['activate'] });
      }
      return devices;
    },

    async state(config, device, ctx) {
      ctx = using(ctx);
      if (device.kind === 'scene') return {};
      const [resource] = unwrap((await call(config, resourcePath(device), ctx)).data);
      return stateOf(resource);
    },

    async act(config, device, action, value, ctx) {
      ctx = using(ctx);
      const path = resourcePath(device);
      unwrap((await call(config, path, ctx, { method: 'PUT', body: bodyFor(device, action, value) })).data);
      if (device.kind === 'scene') return { confirmed: false };
      await ctx.sleep?.(300);
      try {
        const [resource] = unwrap((await call(config, path, ctx)).data);
        return { confirmed: confirms(resource, action, value, device) };
      } catch { return { confirmed: false }; }
    },

    async disconnect(config, ctx) {
      ctx = using(ctx);
      if (!config?.app_key) return { revoked: false, message: 'Pairing had not finished, so no key was ever created on the bridge.' };
      const revoked = await revokeKey(config, config.app_key, ctx);
      return revoked ? { revoked: true, message: 'MERLIN’s key was removed from the Hue Bridge.' } : { revoked: false, message: NOT_REVOKED };
    },
  };
}
