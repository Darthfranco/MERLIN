import { ConnectorError, cleanText, requestJson, serviceUrl } from './base.js';

// Home Assistant REST API with a long-lived access token.
// https://developers.home-assistant.io/docs/api/rest/
//
// This one connection is also the supported route to the many brands Home Assistant already integrates (Sonos,
// LG webOS, Lutron, Roborock, ...): once a device is working in Home Assistant, MERLIN controls the entities it exposes.

const COVER_FEATURES = { open: 1, close: 2, position: 4, stop: 8 };
const CLIMATE_FEATURES = { target: 1, turn_off: 128, turn_on: 256 };
// Doors people can walk or drive through are never driven by MERLIN: not opened, not closed.
const RESTRICTED_COVERS = new Set(['garage', 'gate', 'door']);
const LIGHT_BRIGHTNESS_MODES = new Set(['brightness', 'color_temp', 'hs', 'xy', 'rgb', 'rgbw', 'rgbww', 'white']);

const percent = value => Math.round((Number(value) / 255) * 100);
const feature = (attributes, bit) => (Number(attributes.supported_features) & bit) === bit;
const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

function mapEntity(entity, config) {
  const [domain] = String(entity?.entity_id ?? '').split('.');
  const attributes = entity.attributes && typeof entity.attributes === 'object' ? entity.attributes : {};
  const on = entity.state === 'on';
  const base = { id: entity.entity_id, name: attributes.friendly_name || entity.entity_id, available: entity.state !== 'unavailable' };
  switch (domain) {
    case 'light': {
      const modes = Array.isArray(attributes.supported_color_modes) ? attributes.supported_color_modes : [];
      const actions = ['turn_on', 'turn_off', 'toggle'];
      if (modes.some(mode => LIGHT_BRIGHTNESS_MODES.has(mode))) actions.push('set_brightness');
      if (modes.includes('color_temp')) actions.push('set_color_temperature');
      return { ...base, kind: 'light', state: { on, brightness: on ? percent(attributes.brightness) : undefined }, actions };
    }
    case 'switch': return { ...base, kind: 'switch', state: { on }, actions: ['turn_on', 'turn_off', 'toggle'] };
    case 'fan': return { ...base, kind: 'fan', state: { on }, actions: ['turn_on', 'turn_off', 'toggle'] };
    case 'cover': {
      const restricted = RESTRICTED_COVERS.has(attributes.device_class);
      const actions = restricted ? [] : [
        ...(feature(attributes, COVER_FEATURES.open) ? ['open'] : []), ...(feature(attributes, COVER_FEATURES.close) ? ['close'] : []),
        ...(feature(attributes, COVER_FEATURES.stop) ? ['stop'] : []), ...(feature(attributes, COVER_FEATURES.position) ? ['set_position'] : []),
      ];
      return { ...base, kind: 'cover', state: { on: entity.state === 'open', position: number(attributes.current_position) }, actions };
    }
    case 'lock': return { ...base, kind: 'lock', state: { locked: entity.state === 'locked' }, actions: ['lock'] };
    case 'climate': {
      const actions = [...(feature(attributes, CLIMATE_FEATURES.target) ? ['set_temperature'] : []),
        ...(feature(attributes, CLIMATE_FEATURES.turn_on) ? ['turn_on'] : []), ...(feature(attributes, CLIMATE_FEATURES.turn_off) ? ['turn_off'] : [])];
      return { ...base, kind: 'climate', state: { on: entity.state !== 'off', temperature: number(attributes.current_temperature) }, actions, extra: { min: number(attributes.min_temp), max: number(attributes.max_temp), unit: config.temperature_unit } };
    }
    case 'vacuum': return { ...base, kind: 'vacuum', state: { running: entity.state === 'cleaning' }, actions: ['start', 'stop'] };
    case 'scene': return { ...base, kind: 'scene', state: {}, actions: ['activate'] };
    default: return null;
  }
}

const toUnit = (celsius, unit) => (unit === '°F' ? (celsius * 9) / 5 + 32 : celsius);

function serviceFor(device, action, value, config) {
  const domain = device.id.split('.')[0];
  const target = { entity_id: device.id };
  switch (`${domain}:${action}`) {
    case 'light:turn_on': case 'switch:turn_on': case 'fan:turn_on': return [domain, 'turn_on', target];
    case 'light:turn_off': case 'switch:turn_off': case 'fan:turn_off': return [domain, 'turn_off', target];
    case 'light:toggle': case 'switch:toggle': case 'fan:toggle': return [domain, 'toggle', target];
    case 'light:set_brightness': return value === 0 ? ['light', 'turn_off', target] : ['light', 'turn_on', { ...target, brightness_pct: value }];
    case 'light:set_color_temperature': return ['light', 'turn_on', { ...target, color_temp_kelvin: value }];
    case 'cover:open': return ['cover', 'open_cover', target];
    case 'cover:close': return ['cover', 'close_cover', target];
    case 'cover:stop': return ['cover', 'stop_cover', target];
    case 'cover:set_position': return ['cover', 'set_cover_position', { ...target, position: value }];
    case 'lock:lock': return ['lock', 'lock', target];
    case 'climate:set_temperature': {
      const { min, max, unit } = device.extra ?? {};
      const temperature = Math.round(toUnit(value, unit ?? config.temperature_unit) * 10) / 10;
      if ((min !== undefined && temperature < min) || (max !== undefined && temperature > max)) throw new ConnectorError('invalid', `${device.name} accepts ${min} to ${max} ${unit ?? ''}.`.trim());
      return ['climate', 'set_temperature', { ...target, temperature }];
    }
    case 'climate:turn_on': return ['climate', 'turn_on', target];
    case 'climate:turn_off': return ['climate', 'turn_off', target];
    case 'vacuum:start': return ['vacuum', 'start', target];
    case 'vacuum:stop': return ['vacuum', 'stop', target];
    case 'scene:activate': return ['scene', 'turn_on', target];
    default: throw new ConnectorError('unsupported', `${device.name} can’t do that through MERLIN.`);
  }
}

/** Whether the entity now reports what was asked. Anything still moving or unknown is not confirmed. */
function confirms(entity, action, value) {
  const attributes = entity.attributes ?? {};
  switch (action) {
    case 'turn_on': return entity.state === 'on' || (entity.entity_id.startsWith('climate.') && entity.state !== 'off');
    case 'turn_off': return entity.state === 'off';
    case 'set_brightness': return value === 0 ? entity.state === 'off' : entity.state === 'on' && Math.abs(percent(attributes.brightness) - value) <= 3;
    case 'set_color_temperature': return entity.state === 'on';
    case 'open': return entity.state === 'open';
    case 'close': return entity.state === 'closed';
    case 'set_position': return Math.abs(Number(attributes.current_position) - value) <= 2;
    case 'lock': return entity.state === 'locked';
    case 'set_temperature': return typeof attributes.temperature === 'number';
    case 'start': return entity.state === 'cleaning';
    case 'stop': return ['idle', 'paused', 'docked', 'stopped'].includes(entity.state) || entity.state === 'stopped';
    default: return false;
  }
}

const api = (config, path, ctx, options = {}) => requestJson(`${config.url}/api${path}`, {
  service: 'Home Assistant', headers: { Authorization: `Bearer ${config.token}` }, signal: ctx.signal, fetch: ctx.fetch, ...options,
});

async function describeInstance(url, token, ctx) {
  const config = { url, token };
  const running = await api(config, '/', ctx);
  if (!running.data || typeof running.data.message !== 'string') throw new ConnectorError('failed', 'That address answered, but it does not look like Home Assistant’s API.');
  const info = (await api(config, '/config', ctx)).data ?? {};
  return { ...config, name: cleanText(info.location_name || 'Home Assistant', 60), version: cleanText(info.version || '', 20), temperature_unit: info.unit_system?.temperature === '°F' ? '°F' : '°C' };
}

export function homeAssistant() {
  return {
    id: 'home-assistant',
    name: 'Home Assistant',
    summary: 'Control the lights, switches, fans, blinds, locks (lock only), thermostats, vacuums and scenes already working in your Home Assistant.',
    kinds: ['light', 'switch', 'fan', 'cover', 'lock', 'climate', 'vacuum', 'scene'],
    fields: [
      { name: 'url', label: 'Home Assistant address', type: 'url', placeholder: 'http://homeassistant.local:8123', help: 'The address you open Home Assistant at on this network.' },
      { name: 'token', label: 'Long-lived access token', type: 'secret', placeholder: 'Paste the token', help: 'In Home Assistant open your profile, choose Security, then Long-lived access tokens, and create one named MERLIN.' },
    ],
    publicConfig: config => ({ url: config.url, name: config.name, version: config.version }),

    async connect(input, current, ctx) {
      const url = serviceUrl(input.url ?? current?.url, { name: 'Home Assistant' });
      const token = input.token || (current?.url === url ? current.token : '');
      if (!token) throw new ConnectorError('invalid', 'Paste a long-lived access token from your Home Assistant profile.');
      const config = await describeInstance(url, token, ctx);
      return { config, summary: `Connected to ${config.name} (Home Assistant ${config.version || 'running'}).` };
    },

    async verify(config, ctx) {
      const next = await describeInstance(config.url, config.token, ctx);
      return { config: next, summary: `${next.name} answered with the saved token.` };
    },

    async devices(config, ctx) {
      const { data } = await api(config, '/states', ctx, { maxBytes: 8_000_000 });
      if (!Array.isArray(data)) throw new ConnectorError('failed', 'Home Assistant sent a device list MERLIN could not read.');
      return data.map(entity => mapEntity(entity, config)).filter(device => device && device.available);
    },

    async state(config, device, ctx) {
      const { data } = await api(config, `/states/${encodeURIComponent(device.id)}`, ctx);
      return mapEntity(data, config)?.state ?? {};
    },

    async act(config, device, action, value, ctx) {
      const [domain, service, body] = serviceFor(device, action, value, config);
      await api(config, `/services/${domain}/${service}`, ctx, { method: 'POST', body });
      if (action === 'toggle' || action === 'activate') return { confirmed: false };
      await ctx.sleep?.(500);
      try {
        const { data } = await api(config, `/states/${encodeURIComponent(device.id)}`, ctx);
        return { confirmed: confirms(data, action, value) };
      } catch { return { confirmed: false }; }
    },

    async disconnect() {
      return { revoked: false, message: 'Home Assistant tokens cannot be revoked from outside it. To finish, delete the MERLIN token in Home Assistant under your profile, Security, Long-lived access tokens.' };
    },
  };
}
