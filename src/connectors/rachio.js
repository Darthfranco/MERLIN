import { ConnectorError, cleanText, requestJson } from './base.js';

// Rachio smart sprinkler controllers through Rachio's public API with a personal API key.
// https://rachio.readme.io/reference/getting-started   (3,500 requests per day, reset at midnight UTC)
//
// Only the documented controller API is used: list controllers and zones, run one zone for a stated number of
// minutes, and stop all watering on a controller. The Smart Hose Timer uses a different API and is not supported.
// There is no scheduling, rain delay, standby or program editing here.

const BASE = 'https://api.rach.io/1/public';
const ID = /^[0-9a-f][0-9a-f-]{6,62}$/iu;
const MAX_SECONDS = 10_800;
const CONFIRM_DELAY_MS = 2000;

const api = (config, path, ctx, options = {}) => requestJson(`${BASE}${path}`, {
  service: 'Rachio', headers: { Authorization: `Bearer ${config.api_key}` }, signal: ctx.signal, fetch: ctx.fetch, ...options,
});

const safeId = value => {
  if (typeof value !== 'string' || !ID.test(value)) throw new ConnectorError('failed', 'Rachio sent an identifier MERLIN could not use.');
  return value;
};

async function loadPerson(apiKey, ctx) {
  const config = { api_key: apiKey };
  const { data: info } = await api(config, '/person/info', ctx);
  const personId = safeId(info?.id);
  const { data: person } = await api(config, `/person/${encodeURIComponent(personId)}`, ctx);
  const controllers = (Array.isArray(person?.devices) ? person.devices : []).filter(device => device && device.deleted !== true && typeof device.id === 'string');
  return { personId, controllers };
}

function describe(personId, apiKey, controllers) {
  if (!controllers.length) throw new ConnectorError('failed', 'No Rachio controller was found on this account (Smart Hose Timers are not supported).');
  return { api_key: apiKey, person_id: personId, controllers: controllers.length };
}

const running = (schedule, zoneId) => typeof schedule?.zoneId === 'string' && (zoneId === undefined || schedule.zoneId === zoneId);

export function rachio() {
  const parse = id => {
    const [kind, controller, zone] = String(id).split(':');
    if (!['device', 'zone'].includes(kind)) throw new ConnectorError('device', 'That sprinkler is no longer available.');
    return { kind, controller: safeId(controller), ...(kind === 'zone' ? { zone: safeId(zone) } : {}) };
  };

  return {
    id: 'rachio',
    name: 'Rachio',
    summary: 'Run a Rachio sprinkler zone for a number of minutes, or stop all watering, on Rachio smart sprinkler controllers. Smart Hose Timers are not supported.',
    kinds: ['sprinkler'],
    cacheMs: 30_000,
    fields: [
      { name: 'api_key', label: 'Rachio API key', type: 'secret', placeholder: 'Paste the key', help: 'In the Rachio app tap the Profile icon, choose API key, then Copy.' },
    ],
    publicConfig: config => ({ controllers: config.controllers ?? 0 }),

    async connect(input, current, ctx) {
      const apiKey = input.api_key || current?.api_key;
      if (!apiKey) throw new ConnectorError('invalid', 'Paste your Rachio API key.');
      const { personId, controllers } = await loadPerson(apiKey, ctx);
      const config = describe(personId, apiKey, controllers);
      return { config, summary: `Connected ${config.controllers} Rachio controller${config.controllers === 1 ? '' : 's'}.` };
    },

    async verify(config, ctx) {
      const { personId, controllers } = await loadPerson(config.api_key, ctx);
      const next = describe(personId, config.api_key, controllers);
      return { config: next, summary: `Rachio answered with the saved key (${next.controllers} controller${next.controllers === 1 ? '' : 's'}).` };
    },

    async devices(config, ctx) {
      const { data: person } = await api(config, `/person/${encodeURIComponent(safeId(config.person_id))}`, ctx);
      const out = [];
      for (const controller of (Array.isArray(person?.devices) ? person.devices : []).filter(item => item && item.deleted !== true && typeof item.id === 'string')) {
        const online = controller.status === 'ONLINE';
        const label = cleanText(controller.name || controller.model || 'Sprinkler controller', 60);
        out.push({ id: `device:${safeId(controller.id)}`, name: label, kind: 'sprinkler', state: { reachable: online }, actions: online ? ['stop'] : [] });
        const zones = (Array.isArray(controller.zones) ? controller.zones : []).filter(zone => zone && zone.enabled === true && typeof zone.id === 'string')
          .sort((a, b) => (a.zoneNumber ?? 0) - (b.zoneNumber ?? 0));
        for (const zone of zones) {
          out.push({ id: `zone:${safeId(controller.id)}:${safeId(zone.id)}`, name: cleanText(zone.name || `Zone ${zone.zoneNumber ?? ''}`, 60), room: label, kind: 'sprinkler', state: { reachable: online }, actions: online ? ['start'] : [] });
        }
      }
      return out;
    },

    async state(config, device, ctx) {
      const target = parse(device.id);
      const [schedule, controller] = await Promise.all([
        api(config, `/device/${target.controller}/current_schedule`, ctx, { empty: true }),
        api(config, `/device/${target.controller}`, ctx),
      ]);
      return { reachable: controller.data?.status === 'ONLINE', running: running(schedule.data, target.zone) };
    },

    async act(config, device, action, value, ctx) {
      const target = parse(device.id);
      if (action === 'start' && target.kind === 'zone') {
        if (value === undefined) throw new ConnectorError('invalid', 'How many minutes should it run?');
        const duration = Math.min(MAX_SECONDS, Math.round(value * 60));
        if (duration < 1) throw new ConnectorError('invalid', 'Watering must run for at least a minute.');
        await api(config, '/zone/start', ctx, { method: 'PUT', body: { id: target.zone, duration }, empty: true });
      } else if (action === 'stop' && target.kind === 'device') {
        await api(config, '/device/stop_water', ctx, { method: 'PUT', body: { id: target.controller }, empty: true });
      } else throw new ConnectorError('unsupported', `${device.name} can’t do that through MERLIN.`);
      // A 204 only means Rachio accepted the request. The controller's cloud-reported schedule says what is running.
      await ctx.sleep?.(CONFIRM_DELAY_MS);
      try {
        const { data } = await api(config, `/device/${target.controller}/current_schedule`, ctx, { empty: true });
        return { confirmed: action === 'start' ? running(data, target.zone) : !running(data) };
      } catch { return { confirmed: false }; }
    },

    async disconnect() {
      return { revoked: false, message: 'Rachio keys cannot be revoked through its API. MERLIN forgot the key. To make the old key stop working, get a new one in the Rachio app (Profile, API key, Get new key).' };
    },
  };
}
