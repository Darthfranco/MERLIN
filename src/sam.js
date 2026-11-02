// SAM 3.1 answers in special-token text, not JSON. Live output for one image looks like:
//   <0f>0<|box;x1=242;y1=338;x2=437;y2=586;w=682;h=1024;c=0.94|><|mask;x=0;y=0;c=0.94;data=249,196,!…|>,1<|box;…|>…
// Fields are read by key, as Meta's reading guide advises. Masks are base85 in an alphabet Meta does not
// publish, so only boxes are used here; decoding them would mean adopting @meta-sam/parser, whose license needs review.
export const SAM_MODEL = 'sam-3.1';
const MIN_CONFIDENCE = 0.5;
const MAX_MATCHES = 8;
const RECORD = /(?:<\d+f>|,)(\d+)<\|box;([^|<>]*)\|>/gu;
const NUMERIC = /^\d+(?:\.\d+)?(?:e-?\d+)?$/u;

/** @returns one { x1, y1, x2, y2, width, height, confidence } per match. No matches is a normal, empty result. */
export function parseSegmentation(text) {
  const matches = [];
  for (const [, , body] of String(text ?? '').matchAll(RECORD)) {
    const fields = Object.fromEntries(body.split(';').map(pair => pair.split('=')).filter(pair => pair.length === 2 && NUMERIC.test(pair[1])).map(([key, value]) => [key, Number(value)]));
    const { x1, y1, x2, y2, w, h, c } = fields;
    if (![x1, y1, x2, y2, w, h].every(Number.isFinite) || x2 < x1 || y2 < y1 || x2 >= w || y2 >= h) continue;
    if (c !== undefined && c < MIN_CONFIDENCE) continue;
    matches.push({ x1, y1, x2, y2, width: w, height: h, confidence: c ?? null });
    if (matches.length === MAX_MATCHES) break;
  }
  return matches;
}
