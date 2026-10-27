import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpokenText } from '../public/shared/spoken-text.js';

test('temperatures keep values, signs and supplied units while saying their full names', () => {
  assert.equal(normalizeSpokenText('It is 16°F, not 12c. Low: −2.5°C. Then +1℉ and 0℃.'),
    'It is 16 degrees Fahrenheit, not 12 degrees Celsius. Low: minus 2 point five degrees Celsius. Then plus 1 degree Fahrenheit and 0 degrees Celsius.');
  assert.equal(normalizeSpokenText('Weather: 16f/12c; forecast: -5–-1°C.'),
    'Weather: 16 degrees Fahrenheit, 12 degrees Celsius; forecast: minus 5 to minus 1 degrees Celsius.');
  assert.equal(normalizeSpokenText('16°C–20°C; −5°F–−1°F; temperature: 16F–12C.'),
    '16 to 20 degrees Celsius; minus 5 to minus 1 degrees Fahrenheit; temperature: 16 degrees Fahrenheit to 12 degrees Celsius.');
  assert.equal(normalizeSpokenText('−.5°C and +.05°F.'), 'minus 0 point five degrees Celsius and plus 0 point zero five degrees Fahrenheit.');
});

test('percentages and common currency amounts preserve precision and negation', () => {
  assert.equal(normalizeSpokenText('Not 12.5%; 3–5%. $12.50, €1.01, £0.01, -$2.05, $1.005.'),
    'Not 12 point five percent; 3 to 5 percent. 12 dollars and 50 cents, 1 euro and 1 cent, 1 penny, minus 2 dollars and 5 cents, 1 point zero zero five dollars.');
  assert.equal(normalizeSpokenText('$0.00 and £1.20 and €0.50.'), '0 dollars and 1 pound and 20 pence and 50 cents.');
  assert.equal(normalizeSpokenText('20%–30%; $3–5; €1–€2.'), '20 to 30 percent; 3 dollars to 5 dollars; 1 euro to 2 euros.');
  assert.equal(normalizeSpokenText('$.50 and .5%.'), '50 cents and 0 point five percent.');
});

test('known household units and ranges get names, singulars, and spoken separators', () => {
  assert.equal(normalizeSpokenText('1kg, 2 kg, 25mg, 1 cm, 2mm, 30ml, 1oz, 2lbs; 1hr 2min 3sec.'),
    '1 kilogram, 2 kilograms, 25 milligrams, 1 centimeter, 2 millimeters, 30 milliliters, 1 ounce, 2 pounds; 1 hour 2 minutes 3 seconds.');
  assert.equal(normalizeSpokenText('Wind: 10km/h and 1mph. Wait 3–5 minutes; travel 2-4 km.'),
    'Wind: 10 kilometers per hour and 1 mile per hour. Wait 3 to 5 minutes; travel 2 to 4 kilometers.');
  assert.equal(normalizeSpokenText('1kg–2kg; 1cm–20mm.'), '1 to 2 kilograms; 1 centimeter to 20 millimeters.');
});

test('fractions expand only when explicit or followed by a known measurement', () => {
  assert.equal(normalizeSpokenText('Use ½ cup, 1¼ tsp, 2 ¾ cups, 1/2 tbsp, and 2/3 cup.'),
    'Use one half cup, 1 and one quarter teaspoons, 2 and three quarters cups, one half tablespoon, and two thirds cup.');
  assert.equal(normalizeSpokenText('A ½, a ¼, and ¾. Dates: 1/2 and 03/04/2026.'),
    'A one half, a one quarter, and three quarters. Dates: 1/2 and 03/04/2026.');
});

test('explicit clock times expand without guessing ambiguous durations or dates', () => {
  assert.equal(normalizeSpokenText('At 7:05pm, the time is 14:30, the clock reads 00:15; then 12 a.m.'),
    'At seven oh five P M, the time is two thirty P M, the clock reads twelve fifteen A M; then twelve A M.');
  assert.equal(normalizeSpokenText('At 4 p.m. Next task.'), 'At four P M. Next task.');
  assert.equal(normalizeSpokenText('03:30, ratio 16:12, 2026-10-27, 03/04/2026, 2026-10-27T14:30:00Z.'),
    '03:30, ratio 16:12, 2026-10-27, 03/04/2026, 2026-10-27T14:30:00Z.');
});

test('Markdown prose labels and list pauses become speech without reading destinations', () => {
  assert.equal(normalizeSpokenText('# Weather\n- **16°C**\n- Wind: _10 km/h_\n1. See [the forecast](https://example.test/weather).'),
    'Weather.\n16 degrees Celsius.\nWind: 10 kilometers per hour.\nSee the forecast.');
});

test('code, raw addresses, paths, identifiers, and native Kokoro links stay exact', () => {
  const protectedText = '`16°F and $2`\n```js\nconst rate = "20%";\n```\nhttps://example.test/16F?q=20% me@example.test /tmp/16F.txt ./12C/2kg C:\\tmp\\16F.txt [so](+2) [Kokoro](/kˈOkəɹO/)';
  assert.equal(normalizeSpokenText(protectedText), protectedText);
  assert.equal(normalizeSpokenText('```js\nconst sample = "16°F";'), '```js\nconst sample = "16°F";');
  const ambiguous = 'ID-16F F-16 C3 #16f v1.2kg A16C room_12C 5 m 10 qps 2kg/3kg 16F-ABC 1/2/2026 2*3*4 2**3**4';
  assert.equal(normalizeSpokenText(ambiguous), ambiguous);
});

test('required literal phrases survive exactly, including overlapping shorthand and Markdown', () => {
  const literal = '**16°F**\n$12.50, mister!';
  assert.equal(normalizeSpokenText(`${literal} Outside is 12°C.`, { literalPhrases: ['16°F', literal] }),
    `${literal} Outside is 12 degrees Celsius.`);
  assert.equal(normalizeSpokenText('16°F 16°F Weather: 16f.', { literalPhrases: ['16°F'] }), '16°F 16°F Weather: 16 degrees Fahrenheit.');
  const nested = '`16°F` [16°F](+2) https://example.test/16°F MERLIN 0 1';
  assert.equal(normalizeSpokenText(nested, { literalPhrases: ['16°F', 'MERLIN', '0', '1'] }), nested);
  assert.equal(normalizeSpokenText('$12.50 and 16°F.', { literalPhrases: ['$12.50'] }), '$12.50 and 16 degrees Fahrenheit.');
});

test('ambiguous identifiers, compound units, and media offsets stay exact without partial numeric matches', () => {
  for (const text of ['Your seat is 16F.', 'The apartment is 4C.', 'Seats 16F/12C.', '16F',
    'The rate is $1.25/kg.', '$1,250/kg', '1.5kg/m2', '2.5mg/kg', 'Use 1,25kg.', 'Pause the video at 00:30.', 'Arrive by 09:00.']) {
    assert.equal(normalizeSpokenText(text), text);
  }
  assert.equal(normalizeSpokenText('The temperature is 16F.'), 'The temperature is 16 degrees Fahrenheit.');
  assert.equal(normalizeSpokenText('Add 1-1/2 cups.'), 'Add 1 and one half cups.');
  assert.equal(normalizeSpokenText('Add 2-3/4 tsp.'), 'Add 2 and three quarters teaspoons.');
  assert.equal(normalizeSpokenText('Use 1,250 kg.'), 'Use 1,250 kilograms.');
});

test('normal prose and every normalized output are idempotent', () => {
  const samples = [
    'Righto, mister! Your tea timer is set for 30 seconds.',
    'It is not minus five degrees Celsius. The cost is 12 dollars and 50 cents.',
    '2026. It is a year, with no measurement shorthand.',
    '16f/12c, 3–5 minutes, ½ cup, 2/3 cup, $12.50, −2.05°C, at 14:30.',
    '# Weather\n- **16°C**\n- 10km/h. [Forecast](https://example.test/weather)',
    '[Kokoro](/kˈOkəɹO/) `16°F` https://example.test/16F',
  ];
  for (const sample of samples) {
    const normalized = normalizeSpokenText(sample);
    assert.equal(normalizeSpokenText(normalized), normalized, sample);
  }
  assert.equal(normalizeSpokenText(samples[0]), samples[0]);
  assert.equal(normalizeSpokenText(samples[1]), samples[1]);
  assert.equal(normalizeSpokenText(samples[2]), samples[2]);
});
