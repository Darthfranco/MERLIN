// Shared pieces for real service connectors.
//
// A connector is a plain object (see CONNECTOR INTERFACE below). The hub owns
// storage, status and tool exposure; a connector only knows how to talk to one
// service. Credentials never leave the server: they are stored in
// data/connectors.json and are not part of any status, tool result, trace or
// error message.
//
// CONNECTOR INTERFACE
//   id, name, summary          catalog id, display name, one honest sentence about what it does
//   fields                     [{name, label, type: 'text'|'url'|'secret', required, placeholder, help}]
//   kinds                      device kinds it can expose (see KINDS)
//   async connect(input, current, ctx)
//        Contact the service and prove access. Returns {config, summary} and, for a
//        multi-step setup, {pending: 'what to do next'} to mean "saved, not verified".
//        Throws ConnectorError. `config` is the complete object to persist.
//   async verify(config, ctx)    Prove saved credentials still work. Returns {summary}.
//   async devices(config, ctx)   Device[] (see below). Names are untrusted display text.
//   async state(config, device, ctx)   Optional live state for one device.
//   async act(config, device, action, value, ctx)
//        Perform one validated action. Returns {message, confirmed, state?}. `confirmed` is true only when
//        the service reported the resulting state; `state` is that reported state, when the service gives it.
//   async disconnect(config, ctx) Revoke where the service supports it. Returns {revoked, message}.
//   simulated                    Optional. true only for the labeled demo home; it is named as simulated everywhere.
//   operations                   Optional named extra setup steps: {name: {label, run(config, input, ctx)}}.
//   publicConfig(config)         Non-secret fields that are safe to show.
//   ctx = {fetch, signal, now}
//
// Device = {id, name, kind, room?, state?, actions[]}
//   state keys: on, brightness (0-100), position (0-100), locked, temperature, unit, humidity, power_w, running

export const KINDS = Object.freeze(['light', 'room', 'switch', 'fan', 'cover', 'lock', 'climate', 'scene', 'media', 'vacuum', 'sprinkler', 'humidifier', 'button', 'oven']);

// One small vocabulary. A connector lists the subset each device really supports.
// There is deliberately no "unlock": MERLIN will lock, never unlock, a door.
export const ACTIONS = Object.freeze({
  turn_on: {}, turn_off: {}, toggle: {},
  set_brightness: { value: 'number', min: 0, max: 100, unit: 'percent' },
  set_color_temperature: { value: 'number', min: 1500, max: 9000, unit: 'kelvin' },
  set_position: { value: 'number', min: 0, max: 100, unit: 'percent open' },
  open: {}, close: {}, stop: {}, lock: {}, activate: {}, press: {},
  // Optional so a vacuum can start; a sprinkler connector requires the minutes itself.
  start: { value: 'number', min: 1, max: 180, unit: 'minutes', optional: true },
  set_temperature: { value: 'number', min: 5, max: 35, unit: 'degrees Celsius' },
  preheat: { value: 'number', min: 170, max: 550, unit: 'degrees Fahrenheit' },
});

export class ConnectorError extends Error {
  /** kind: auth | rate_limit | unreachable | invalid | unsupported | device | failed */
  constructor(kind, message, { retryAfter } = {}) {
    super(message);
    this.name = 'ConnectorError';
    this.kind = kind;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export const isConnectorError = error => error instanceof ConnectorError;

const cleanText = (value, max = 120) => String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);
/** Names come from third-party services; keep them short, single-line plain text. */
export const displayName = (value, fallback = 'Unnamed') => cleanText(value, 80) || fallback;
export { cleanText };

export const normalizeName = value => String(value ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/['’`]/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  .replace(/^(?:the|my|a|an)\s+/u, '').replace(/\s+/gu, ' ');

// ---- address safety for local-network devices ---------------------------------------------------------------------

const PRIVATE_V4 = /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/u;
const LOCAL_NAME = /^(?:[a-z0-9-]+)(?:\.(?:local|lan|home|home\.arpa|internal|localdomain))?$/iu;

/** Accept only a bare host or IP on the household network. Never a URL, port, path or credential. */
export function localHost(value, { allowPort = false } = {}) {
  const text = String(value ?? '').trim();
  const match = allowPort ? text.match(/^([^:/@\s]+)(?::(\d{2,5}))?$/u) : text.match(/^([^:/@\s]+)$/u);
  if (!match || match[1].length > 253) throw new ConnectorError('invalid', 'Enter just the device address on your home network, such as 192.168.1.20.');
  const host = match[1];
  const numeric = /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host);
  if (numeric) {
    if (host.split('.').some(part => Number(part) > 255)) throw new ConnectorError('invalid', 'That is not a valid IP address.');
    if (!PRIVATE_V4.test(host)) throw new ConnectorError('invalid', 'Use the device’s home-network address (for example 192.168.x.x), not an internet address.');
  } else if (!LOCAL_NAME.test(host)) {
    throw new ConnectorError('invalid', 'Use the device’s IP address or a .local name on your home network.');
  }
  return match[2] ? `${host}:${Number(match[2])}` : host;
}

/** A user-supplied service address: http(s), a host, optional port, no credentials, query or fragment. */
export function serviceUrl(value, { name = 'service' } = {}) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw new ConnectorError('invalid', `Enter the full ${name} address, for example http://homeassistant.local:8123.`); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new ConnectorError('invalid', `Enter the ${name} address as http:// or https:// with no password, query or extras.`);
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, '')}`;
}

// ---- HTTP ---------------------------------------------------------------------------------------------------------

const TIMEOUT_MS = 8000;
const MAX_BYTES = 2_000_000;

async function readLimited(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) return await response.text();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new ConnectorError('failed', 'The service sent a response that was too large to read safely.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * JSON over fetch with a timeout, size limit and no redirects. Errors are mapped to ConnectorError
 * using `service` ("Home Assistant") in user-facing wording; response bodies are never echoed.
 */
export async function requestJson(url, { service = 'The service', method = 'GET', headers = {}, body, timeoutMs = TIMEOUT_MS, signal, fetch: fetchImpl = fetch, maxBytes = MAX_BYTES, empty = false } = {}) {
  const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method, redirect: 'error', signal: abort,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
    throw new ConnectorError('unreachable', timedOut ? `${service} did not answer in time. Check that it is on and reachable from this computer.` : `${service} could not be reached. Check the address and that it is on and on your home network.`);
  }
  if (response.status === 401 || response.status === 403) throw new ConnectorError('auth', `${service} rejected the saved credentials. Reconnect it with a fresh token or key.`);
  if (response.status === 429) {
    const retry = Number(response.headers.get('retry-after'));
    throw new ConnectorError('rate_limit', `${service} is rate limiting requests${Number.isFinite(retry) && retry > 0 ? `; try again in about ${Math.ceil(retry)} seconds` : '; try again later'}.`, { retryAfter: Number.isFinite(retry) ? retry : undefined });
  }
  if (response.status === 404) throw new ConnectorError('device', `${service} could not find that item. It may have been removed.`);
  if (!response.ok) throw new ConnectorError('failed', `${service} returned an error (HTTP ${response.status}).`);
  const text = await readLimited(response, maxBytes);
  if (!text.trim()) { if (empty || response.status === 204) return { status: response.status, data: null, headers: response.headers }; throw new ConnectorError('failed', `${service} sent an empty response.`); }
  try { return { status: response.status, data: JSON.parse(text), headers: response.headers }; }
  catch { throw new ConnectorError('failed', `${service} sent a response MERLIN could not read.`); }
}

// ---- argument validation shared by the hub and tests --------------------------------------------------------------

export function checkValue(action, value) {
  const spec = ACTIONS[action];
  if (!spec) throw new ConnectorError('invalid', 'That action is not available.');
  if (!spec.value) {
    if (value !== undefined && value !== null) throw new ConnectorError('invalid', `“${action.replaceAll('_', ' ')}” does not take a value.`);
    return undefined;
  }
  if (spec.optional && (value === undefined || value === null)) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max) {
    throw new ConnectorError('invalid', `${action.replaceAll('_', ' ')} needs a number from ${spec.min} to ${spec.max} (${spec.unit}).`);
  }
  return value;
}
