import { AppError } from '../errors.js';

export const SPEECH_DELIVERIES = Object.freeze(['natural', 'neutral', 'lively', 'gentle']);
export const DEFAULT_SPEECH_DELIVERY = 'natural';
const MAX_SEGMENTS = 32;
const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

export function validateSpeechDelivery(delivery = DEFAULT_SPEECH_DELIVERY) {
  if (!SPEECH_DELIVERIES.includes(delivery)) throw new AppError('Choose natural, neutral, lively, or gentle delivery.');
  return delivery;
}

function sentences(text) {
  // Native Kokoro pronunciation/stress links must reach Misaki intact. Mask their
  // contents only while locating boundaries; synthesis receives the original text.
  const masked = text.replace(/\[[^\]\n]*\]\([^\)\n]*\)/gu, match => 'x'.repeat(match.length));
  const result = [];
  for (const { index, segment } of sentenceSegmenter.segment(masked)) {
    const original = text.slice(index, index + segment.length);
    const previous = result.at(-1);
    if (previous && (!original.trim() || /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|[A-Z])\.\s*$/u.test(previous))) {
      result[result.length - 1] += original;
    } else if (result.length >= MAX_SEGMENTS) {
      result[MAX_SEGMENTS - 1] += original;
    } else {
      result.push(original);
    }
  }
  return result;
}

/** Local delivery controls, not a trained emotion model or a rewrite of the words.
 * Kokoro's own punctuation and explicit [word](+2)/(-1)/(-2) drive intonation.
 * These presets add bounded phrase pacing and short gaps without pitch shifting,
 * mixing voices, inventing emotion tags, or making another provider call.
 */
export function createSpeechPlan(text, { speed = 1, delivery = DEFAULT_SPEECH_DELIVERY } = {}) {
  validateSpeechDelivery(delivery);
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.75 || speed > 1.25) {
    throw new AppError('Choose a speech speed from 0.75 to 1.25.');
  }
  if (delivery === 'neutral') return [{ text, speed, pauseMs: 0 }];

  const parts = sentences(text);
  const base = { natural: 0.99, lively: 1.055, gentle: 0.91 }[delivery];
  const rhythm = { natural: [1, 1.015, 0.985], lively: [1, 1.02, 0.98], gentle: [1, 0.985, 1.01] }[delivery];
  return parts.map((part, index) => {
    const ending = part.trimEnd().replace(/["'”’\])]+$/u, '');
    const question = /\?$/u.test(ending);
    const exclamation = /!$/u.test(ending);
    const trailing = /(?:…|\.{3})$/u.test(ending);
    const inflection = trailing ? 0.96 : question ? 0.98 : exclamation ? 1.035 : 1;
    let pauseMs = delivery === 'gentle' ? 140 : delivery === 'lively' ? 55 : 85;
    if (question) pauseMs += 25;
    if (trailing) pauseMs += 75;
    if (/\n\s*\n/u.test(part)) pauseMs += 80;
    return {
      text: part,
      speed: Math.round(Math.min(1.25, Math.max(0.75, speed * base * rhythm[index % 3] * inflection)) * 1000) / 1000,
      pauseMs: index === parts.length - 1 ? 0 : pauseMs,
    };
  });
}
