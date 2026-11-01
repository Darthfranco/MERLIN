// Safe server-side page reader for MERLIN.
//
// Every page is untrusted DATA. This module fetches a public web page and returns plain text; it never executes
// scripts, never forwards cookies or credentials, and never lets a page steer where MERLIN connects.
//
// Network safety, in order:
//   1. isSafeHttpUrl(): http/https only, no credentials, ports 80/443 (default) plus 8080/8443, no localhost,
//      *.local, *.internal, single-label hosts, and no IP literal in a private/loopback/link-local/CGNAT/
//      multicast/ULA/IPv4-mapped range. WHATWG URL parsing already folds 2130706433, 0x7f.1, 0177.0.0.1 and
//      %31%32%37.0.0.1 into 127.0.0.1, so those forms are caught by the same check.
//   2. DNS is resolved here. If ANY answer is non-public the page is refused.
//   3. The connection is pinned to the validated address (see pinnedLookup), so DNS cannot change between
//      the check and the connect. TLS still verifies the original hostname.
//   4. Redirects are followed by hand (max 3) and every hop repeats steps 1-3.
//   5. 8 s deadline, 1 MiB body cap, identity encoding only, text content types only.
// Error messages are fixed strings. Nothing from a page (URL it redirects to, headers, body) is ever put in one.

import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

export const WEB_PAGE_USER_AGENT = 'MERLIN-home-assistant/0.1 (+local; page reader)';
export const WEB_PAGE_LIMITS = Object.freeze({ maxBytes: 1_048_576, timeoutMs: 8000, maxChars: 6000, maxRedirects: 3, maxUrlLength: 2048 });

const MESSAGES = Object.freeze({
  invalid: 'That is not a valid web address.',
  blocked: 'That page is not allowed.',
  redirect_blocked: 'The page redirected somewhere that is not allowed.',
  dns: 'That address could not be found.',
  unreachable: 'The page could not be reached.',
  timeout: 'The page took too long to answer.',
  redirects: 'The page redirected too many times.',
  redirect: 'The page sent an invalid redirect.',
  unreadable: 'That page is too large or not readable text.',
  empty: 'That page had no readable text. It may need JavaScript to show its content.',
  cancelled: 'The page read was cancelled.',
});

/** code: invalid | blocked | dns | unreachable | timeout | redirects | redirect | http_error | unreadable | empty | cancelled */
export class WebPageError extends Error {
  constructor(code, message = MESSAGES[code] ?? MESSAGES.unreachable, extra = {}) {
    super(message);
    this.name = 'WebPageError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---- addresses ----------------------------------------------------------------------------------------------------

function parseIPv4(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(text);
  if (!match) return null;
  const parts = match.slice(1).map(part => (part.length > 1 && part.startsWith('0') ? NaN : Number(part)));
  return parts.some(part => !(part >= 0 && part <= 255)) ? null : parts;
}

function parseIPv6(input) {
  let text = String(input);
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (text.includes('.')) {
    const cut = text.lastIndexOf(':');
    const v4 = parseIPv4(text.slice(cut + 1));
    if (!v4) return null;
    text = `${text.slice(0, cut + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  if (tail === null && head.length !== 8) return null;
  const missing = tail === null ? 0 : 8 - head.length - tail.length;
  if (missing < 0 || (tail !== null && missing < 1)) return null;
  const groups = [...head, ...Array(missing).fill('0'), ...(tail ?? [])];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/iu.test(group))) return null;
  return groups.map(group => Number.parseInt(group, 16));
}

// [base, prefix bits] for every IPv4 range that is not the public internet.
const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [toNumber(parseIPv4(base)), bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0]);

function toNumber(bytes) { return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0; }

function publicIPv4(bytes) {
  const value = toNumber(bytes);
  return !V4_BLOCKED.some(([base, mask]) => ((value & mask) >>> 0) === base);
}

// Global unicast 2000::/3 minus the special-purpose blocks. Everything else (::1, ::, ::ffff:0:0/96 IPv4-mapped,
// 64:ff9b::/96 NAT64, fc00::/7 ULA, fe80::/10, ff00::/8, ...) is outside 2000::/3 and refused.
const V6_BLOCKED = [[[0x2001, 0], 23], [[0x2001, 0xdb8], 32], [[0x2002], 16], [[0x3fff], 20], [[0x5f00], 16]];

function inPrefix(groups, prefix, bits) {
  let remaining = bits;
  for (let index = 0; remaining > 0; index++, remaining -= 16) {
    const width = Math.min(16, remaining);
    const mask = (0xffff << (16 - width)) & 0xffff;
    if ((groups[index] & mask) !== ((prefix[index] ?? 0) & mask)) return false;
  }
  return true;
}

function publicIPv6(groups) {
  if ((groups[0] & 0xe000) !== 0x2000) return false;
  return !V6_BLOCKED.some(([prefix, bits]) => inPrefix(groups, prefix, bits));
}

/** True only for an address on the public internet. Anything unparseable is not public. */
export function isPublicAddress(address) {
  const text = String(address ?? '').replace(/^\[|\]$/gu, '');
  const family = isIP(text.split('%')[0]);
  if (family === 4) { const bytes = parseIPv4(text); return bytes ? publicIPv4(bytes) : false; }
  if (family === 6) { const groups = parseIPv6(text); return groups ? publicIPv6(groups) : false; }
  return false;
}

// ---- URLs ---------------------------------------------------------------------------------------------------------

const ALLOWED_PORTS = new Set(['', '8080', '8443']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home', '.home.arpa', '.intranet', '.corp', '.private'];
const LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/u;

/** @returns {URL} a normalized, fragment-free URL, or throws WebPageError. */
function parseSafeUrl(raw, { redirect = false } = {}) {
  const refuse = (code = 'blocked') => new WebPageError(code, redirect && code === 'blocked' ? MESSAGES.redirect_blocked : MESSAGES[code]);
  if (typeof raw !== 'string') throw refuse('invalid');
  const text = raw.trim();
  if (!text || text.length > WEB_PAGE_LIMITS.maxUrlLength || /[\u0000- \u007f-\u009f]/u.test(text)) throw refuse('invalid');
  let url;
  try { url = new URL(text); } catch { throw refuse('invalid'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw refuse();
  // Any "@" in the authority is a credential or a parser trick, even when the user part is empty.
  if (url.username || url.password || /^[a-z][a-z0-9+.-]*:(?:\/\/|\\\\)[^/\\?#]*@/iu.test(text)) throw refuse();
  if (!ALLOWED_PORTS.has(url.port)) throw refuse();
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw refuse();
  } else {
    if (host.endsWith('.')) { host = host.slice(0, -1); url.hostname = host; }
    const labels = host.split('.');
    if (!host || host.length > 253 || labels.length < 2 || labels.some(label => !LABEL.test(label))) throw refuse();
    if (host === 'localhost' || BLOCKED_SUFFIXES.some(suffix => host.endsWith(suffix))) throw refuse();
  }
  url.hash = '';
  return url;
}

/** Pure check used by callers before any network work. */
export function isSafeHttpUrl(rawUrl) {
  try { parseSafeUrl(rawUrl); return true; } catch { return false; }
}

// ---- network ------------------------------------------------------------------------------------------------------

/** A dns `lookup` replacement that always answers with the address we already validated. */
export function pinnedLookup(address, family) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (options?.all) callback(null, [{ address, family }]); else callback(null, address, family);
  };
}

/** Default transport: one GET to `address`, never reusing a pooled connection. */
export function nodeTransport({ url, address, family, headers, signal }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const request = client.request(target, { method: 'GET', headers, agent: false, lookup: pinnedLookup(address, family), signal, maxHeaderSize: 32_768 }, response => {
      resolve({ status: response.statusCode, headers: response.headers, body: response, destroy: () => request.destroy() });
    });
    request.on('error', reject);
    request.end();
  });
}

async function defaultResolve(hostname) { return dns.lookup(hostname, { all: true, verbatim: true }); }

function raceAbort(promise, signal, onAbort) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(onAbort());
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

async function validatedTarget(url, resolve, guard, redirected) {
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[')) host = host.slice(1, -1);
  const literal = isIP(host);
  if (literal) return { address: host, family: literal };
  host = host.replace(/\.$/u, '');
  let answers;
  try { answers = await guard(resolve(host)); }
  catch (error) { if (error instanceof WebPageError) throw error; throw new WebPageError('dns'); }
  const list = (Array.isArray(answers) ? answers : [answers]).map(item => (typeof item === 'string' ? { address: item, family: isIP(item) } : item));
  if (!list.length || list.some(item => !item || typeof item.address !== 'string')) throw new WebPageError('dns');
  // One private answer is enough to refuse: the resolver could hand it to a different client later.
  if (list.some(item => !isPublicAddress(item.address))) throw new WebPageError('blocked', redirected ? MESSAGES.redirect_blocked : MESSAGES.blocked);
  const first = list[0];
  return { address: first.address, family: first.family || isIP(first.address) };
}

function normalizeHeaders(raw) {
  const entries = raw && typeof raw.get === 'function' && typeof raw.entries === 'function' ? [...raw.entries()] : Object.entries(raw ?? {});
  const out = {};
  for (const [key, value] of entries) out[String(key).toLowerCase()] = Array.isArray(value) ? value[0] : value;
  return out;
}

async function discard(response) {
  try { response.destroy?.(); } catch { /* already closed */ }
  try { const iterator = response.body?.[Symbol.asyncIterator]?.(); void iterator?.return?.()?.catch?.(() => {}); } catch { /* nothing to release */ }
}

async function readBody(body, maxBytes, guard) {
  const iterator = (body[Symbol.asyncIterator] ?? body[Symbol.iterator]).call(body);
  const chunks = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const next = await guard(iterator.next());
      if (next.done) break;
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      if (size + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    // Do not await: a stalled stream must not stall the caller.
    try { void iterator.return?.()?.catch?.(() => {}); } catch { /* already finished */ }
  }
  return { buffer: Buffer.concat(chunks), truncated };
}

// ---- decoding -----------------------------------------------------------------------------------------------------

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'application/json', 'application/xml', 'text/xml']);

function classify(contentType) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (HTML_TYPES.has(type)) return { type, html: true };
  if (TEXT_TYPES.has(type) || /^application\/[a-z0-9.+-]+\+(?:json|xml)$/u.test(type)) return { type, html: false };
  return null;
}

function decoderFor(label) {
  const clean = String(label ?? '').trim().toLowerCase();
  if (/^[\w.:-]{1,40}$/u.test(clean)) { try { return new TextDecoder(clean); } catch { /* unknown label */ } }
  return null;
}

function decodeBytes(buffer, contentType, html, truncated) {
  let decoder;
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) decoder = decoderFor('utf-8');
  else if (buffer[0] === 0xff && buffer[1] === 0xfe) decoder = decoderFor('utf-16le');
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) decoder = decoderFor('utf-16be');
  if (!decoder) decoder = decoderFor(/charset\s*=\s*["']?([^\s;"']+)/iu.exec(contentType ?? '')?.[1]);
  if (!decoder && html) {
    const head = buffer.subarray(0, 4096).toString('latin1');
    decoder = decoderFor(/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/iu.exec(head)?.[1]);
  }
  let text = (decoder ?? new TextDecoder('utf-8')).decode(buffer);
  if (truncated) text = text.replace(/�+$/u, '');
  return text;
}

// ---- text extraction ----------------------------------------------------------------------------------------------

const ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', bull: '•', middot: '·', laquo: '«', raquo: '»', euro: '€',
  pound: '£', yen: '¥', cent: '¢', sect: '§', deg: '°', plusmn: '±', times: '×', divide: '÷', frac12: '½', frac14: '¼', frac34: '¾',
  micro: 'µ', para: '¶', iexcl: '¡', iquest: '¿', larr: '←', rarr: '→', uarr: '↑', darr: '↓', check: '✓',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê',
  euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö',
  oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', szlig: 'ß',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Auml: 'Ä', Aring: 'Å', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ntilde: 'Ñ', Ouml: 'Ö', Uuml: 'Ü',
});

function decodeEntities(text) {
  return text.replace(/&(?:#(\d{1,10})|#[xX]([0-9a-fA-F]{1,8})|([A-Za-z][A-Za-z0-9]{1,10}));/gu, (whole, dec, hex, name) => {
    if (name) return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : whole;
    const code = dec ? Number(dec) : Number.parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

// Control, zero-width, bidi-override, invisible-format and Unicode "tag" characters (used to hide text from readers).
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFC\u{E0000}-\u{E01EF}]/gu;

function normalizeText(text) {
  return text
    .replace(/[\u2028\u2029]/gu, '\n')
    .replace(INVISIBLE, '')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/gu, ' ')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t\f\v]+/gu, ' ')
    .replace(/ ?\n ?/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  let cut = text.slice(0, maxChars);
  const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  if (boundary > maxChars - 300) cut = cut.slice(0, boundary);
  if (/[\uD800-\uDBFF]$/u.test(cut)) cut = cut.slice(0, -1);
  return { text: cut.trimEnd(), truncated: true };
}

const IGNORED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'form', 'nav', 'footer', 'aside', 'head', 'object', 'embed', 'canvas', 'select']);
const RAW = new Set(['script', 'style']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BREAK_2 = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table', 'ul', 'ol', 'dl', 'hr', 'figure']);
const BREAK_1 = new Set(['address', 'article', 'aside', 'caption', 'dd', 'details', 'dialog', 'div', 'dt', 'fieldset', 'figcaption', 'footer', 'header', 'legend', 'li', 'main', 'nav', 'section', 'summary', 'tbody', 'tfoot', 'thead', 'tr', 'form']);

function parseAttributes(source) {
  const attributes = {};
  for (const match of source.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu)) {
    const name = match[1].toLowerCase();
    if (!Object.hasOwn(attributes, name)) attributes[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/**
 * End of the tag that starts at `from` (just after "<"). Like a browser, a quote only opens an attribute value when it
 * follows "=", so an apostrophe inside an unquoted word cannot swallow the rest of the page.
 */
function tagEnd(text, from) {
  let quote = '';
  let last = '';
  for (let index = from; index < text.length; index++) {
    const char = text[index];
    if (quote) { if (char === quote) { quote = ''; last = char; } continue; }
    if ((char === '"' || char === "'") && last === '=') quote = char;
    else if (char === '>') return index;
    if (!/\s/u.test(char)) last = char;
  }
  return -1;
}

const cleanTitle = value => normalizeText(decodeEntities(value).replace(INVISIBLE, '').replace(/\s+/gu, ' ')).slice(0, 200);

function extract(source, { skipForms }) {
  const html = source.replace(/<!--[\s\S]*?(?:-->|$)/gu, ' ').replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/gu, ' ');
  const buffers = { all: [], main: [], article: [] };
  let mainDepth = 0; let articleDepth = 0; let preDepth = 0;
  let skipName = ''; let skipDepth = 0;
  let title = ''; let socialTitle = '';
  const emit = piece => { buffers.all.push(piece); if (mainDepth) buffers.main.push(piece); if (articleDepth) buffers.article.push(piece); };
  const ignored = name => IGNORED.has(name) && !(name === 'form' && !skipForms);

  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf('<', index);
    const stop = lt < 0 ? html.length : lt;
    if (stop > index && !skipName) {
      const text = decodeEntities(html.slice(index, stop)).replace(INVISIBLE, '');
      emit(preDepth ? text : text.replace(/\s+/gu, ' '));
    }
    if (lt < 0) break;
    const next = html[lt + 1];
    if (next === '!' || next === '?') { const close = html.indexOf('>', lt); if (close < 0) break; index = close + 1; continue; }
    const closing = next === '/';
    const nameStart = lt + (closing ? 2 : 1);
    const nameMatch = /^[A-Za-z][A-Za-z0-9:-]*/u.exec(html.slice(nameStart, nameStart + 40));
    if (!nameMatch) { if (!skipName) emit('<'); index = lt + 1; continue; }
    const end = tagEnd(html, nameStart + nameMatch[0].length);
    if (end < 0) { if (!skipName) emit(decodeEntities(html.slice(lt)).replace(INVISIBLE, '').replace(/\s+/gu, ' ')); break; }
    const name = nameMatch[0].toLowerCase();
    const body = html.slice(nameStart + nameMatch[0].length, end);
    const selfClosing = body.trimEnd().endsWith('/') || VOID.has(name);
    index = end + 1;

    if (!closing && name === 'meta' && skipName !== 'svg') {
      const attributes = parseAttributes(body);
      const key = (attributes.property ?? attributes.name ?? '').toLowerCase();
      if (!socialTitle && (key === 'og:title' || key === 'twitter:title') && attributes.content) socialTitle = cleanTitle(attributes.content);
    }
    if (!closing && (RAW.has(name) || name === 'title') && !selfClosing) {
      const closer = new RegExp(`</${name}\\b`, 'giu');
      closer.lastIndex = index;
      const found = closer.exec(html);
      const contentEnd = found ? found.index : html.length;
      if (name === 'title' && !title && skipName !== 'svg') title = cleanTitle(html.slice(index, contentEnd));
      const close = found ? html.indexOf('>', found.index) : -1;
      index = close < 0 ? html.length : close + 1;
      continue;
    }

    if (skipName) {
      if (name === skipName && !selfClosing) { skipDepth += closing ? -1 : 1; if (skipDepth <= 0) { skipName = ''; skipDepth = 0; } }
      continue;
    }
    if (!closing && ignored(name) && !selfClosing) { skipName = name; skipDepth = 1; continue; }
    if (closing && ignored(name)) continue;

    if (name === 'main') mainDepth = Math.max(0, mainDepth + (closing ? -1 : 1));
    else if (name === 'article') articleDepth = Math.max(0, articleDepth + (closing ? -1 : 1));
    else if (name === 'pre') preDepth = Math.max(0, preDepth + (closing ? -1 : 1));
    // \u0001 and \u0002 are soft breaks (one and two lines) that merge with their neighbours; <br> is a hard newline.
    if (BREAK_2.has(name)) emit('\u0002');
    else if (BREAK_1.has(name)) emit('\u0001');
    else if (name === 'br') emit('\n');
    else if (name === 'td' || name === 'th') emit(' ');
    if (name === 'li' && !closing) emit('- ');
  }
  const join = list => normalizeText(list.join('').replace(/[\u0001\u0002 \t\n]*[\u0001\u0002][\u0001\u0002 \t\n]*/gu, run => (run.includes('\u0002') ? '\n\n' : '\n')));
  return { title: title || socialTitle, all: join(buffers.all), main: join(buffers.main), article: join(buffers.article) };
}

/**
 * HTML to plain text without executing anything. Pure.
 * @returns {{title: string, text: string, truncated: boolean}}
 */
export function htmlToText(html, { maxChars = WEB_PAGE_LIMITS.maxChars } = {}) {
  const source = String(html ?? '');
  let result = extract(source, { skipForms: true });
  // Some sites wrap the whole page in a <form>. Dropping forms must not drop the page.
  if (result.all.length < 40 && /<form\b/iu.test(source)) {
    const again = extract(source, { skipForms: false });
    if (again.all.length > result.all.length) result = again;
  }
  const chosen = [result.main, result.article].find(text => text.length >= 40) ?? result.all;
  return { title: result.title, ...truncate(chosen, maxChars) };
}

function plainToText(text, maxChars) {
  return truncate(normalizeText(text), maxChars);
}

// ---- reader -------------------------------------------------------------------------------------------------------

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch one public page and return readable text.
 * Options (all for tests or tuning): resolve(hostname) -> [{address, family}], transport({url, address, family, headers, signal}),
 * maxBytes, timeoutMs, requestTimeoutMs, maxChars, maxRedirects, signal.
 * @returns {Promise<{url: string, final_url: string, title: string, text: string, truncated: boolean, content_type: string, bytes: number}>}
 */
export async function readWebPage(rawUrl, options = {}) {
  const {
    resolve = defaultResolve, transport = nodeTransport, maxBytes = WEB_PAGE_LIMITS.maxBytes, timeoutMs = WEB_PAGE_LIMITS.timeoutMs,
    requestTimeoutMs = timeoutMs, maxChars = WEB_PAGE_LIMITS.maxChars, maxRedirects = WEB_PAGE_LIMITS.maxRedirects, signal: outer,
  } = options;
  const total = outer ? AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const aborted = () => (outer?.aborted ? new WebPageError('cancelled') : new WebPageError('timeout'));
  const guard = promise => raceAbort(promise, total, aborted);

  const first = parseSafeUrl(rawUrl);
  let current = first;
  for (let redirects = 0; ; redirects++) {
    const target = await validatedTarget(current, resolve, guard, redirects > 0);
    const signal = AbortSignal.any([total, AbortSignal.timeout(requestTimeoutMs)]);
    let response;
    try {
      response = await raceAbort(transport({
        url: current.href, address: target.address, family: target.family, signal,
        headers: { 'user-agent': WEB_PAGE_USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1', 'accept-encoding': 'identity', 'accept-language': 'en' },
      }), signal, aborted);
    } catch (error) {
      if (error instanceof WebPageError) throw error;
      if (total.aborted || signal.aborted) throw aborted();
      throw new WebPageError('unreachable');
    }
    try {
      const status = Number(response.status);
      const headers = normalizeHeaders(response.headers);
      if (REDIRECTS.has(status)) {
        if (redirects >= maxRedirects) throw new WebPageError('redirects');
        let next;
        try { next = new URL(String(headers.location ?? ''), current); } catch { throw new WebPageError('redirect'); }
        if (!headers.location) throw new WebPageError('redirect');
        current = parseSafeUrl(next.href, { redirect: true });
        continue;
      }
      if (!Number.isInteger(status) || status < 200 || status > 299) {
        throw new WebPageError('http_error', `The page returned an error${status >= 100 && status <= 599 ? ` (HTTP ${status})` : ''}.`, { status });
      }
      if (status === 204 || status === 205) throw new WebPageError('empty');
      const kind = classify(headers['content-type']);
      const encoding = String(headers['content-encoding'] ?? 'identity').trim().toLowerCase();
      if (!kind || (encoding && encoding !== 'identity')) throw new WebPageError('unreadable');
      let body;
      try { body = await readBody(response.body, maxBytes, guard); }
      catch (error) {
        if (error instanceof WebPageError) throw error;
        if (total.aborted) throw aborted();
        throw new WebPageError('unreachable');
      }
      const decoded = decodeBytes(body.buffer, headers['content-type'], kind.html, body.truncated);
      const extracted = kind.html ? htmlToText(decoded, { maxChars }) : { title: '', ...plainToText(decoded, maxChars) };
      if (!extracted.text) throw new WebPageError('empty');
      return {
        url: first.href, final_url: current.href, title: extracted.title, text: extracted.text,
        truncated: body.truncated || extracted.truncated, content_type: kind.type, bytes: body.buffer.length,
      };
    } finally {
      await discard(response);
    }
  }
}
