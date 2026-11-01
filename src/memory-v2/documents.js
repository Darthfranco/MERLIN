// Original-text chunking for the existing .txt/.md importer. No summaries or per-chunk model
// calls: a passage is an exact slice of the source with its heading and character offsets.
const TARGET = 900;
const OVERLAP = 120;
const QUALIFIER = /\b(except|exception|unless|note|however|only if|only when|does not|do not|warning|caution|excluding)\b/iu;

function headings(content) {
  const result = [];
  for (const match of content.matchAll(/^(?:#{1,6}\s+(.+)|([^\n]{1,120})\n(?:={3,}|-{3,})\s*$)/gmu)) {
    if (result.length === 500) break;
    result.push({ heading: (match[1] ?? match[2]).trim(), start: match.index });
  }
  if (!result.length || result[0].start !== 0) result.unshift({ heading: 'Introduction', start: 0 });
  return result.map((item, index) => ({ ...item, end: result[index + 1]?.start ?? content.length }));
}

/** A table header stays with every chunk cut from that table, so a row keeps its column meanings. */
function tableHeader(section, offset) {
  // The final element is a partial line: a chunk can start mid-row because of its overlap.
  const before = section.slice(0, offset).split('\n');
  for (let i = before.length - 2; i >= 1; i--) {
    if (!before[i].trim().startsWith('|')) return '';
    if (/^\s*\|?[\s:|-]+\|?\s*$/u.test(before[i]) && before[i - 1].trim().startsWith('|')) return before[i - 1].trim();
  }
  return '';
}

export function chunkDocument(content) {
  const passages = [];
  for (const section of headings(content)) {
    const text = content.slice(section.start, section.end);
    if (!text.trim()) continue;
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(text.length, offset + TARGET);
      if (end < text.length) {
        const paragraph = text.lastIndexOf('\n\n', end);
        const line = text.lastIndexOf('\n', end);
        const sentence = text.lastIndexOf('. ', end);
        const cut = [paragraph, line, sentence].find(index => index > offset + TARGET / 2);
        if (cut !== undefined) end = cut + (cut === sentence ? 2 : 1);
      }
      const slice = text.slice(offset, end);
      if (slice.trim()) passages.push({
        section: section.heading, start: section.start + offset, end: section.start + end, text: slice, header: tableHeader(text, offset),
      });
      if (end >= text.length) break;
      offset = Math.max(offset + 1, end - OVERLAP);
    }
  }
  return passages;
}

export function outline(content) {
  return headings(content).map(({ heading, start, end }) => ({ heading, start, end }));
}

/** Nearby qualifications from the same section travel with a selected passage. */
export function qualifierNote(passage, neighbours, maximum = 400) {
  for (const other of neighbours) {
    if (other.section === passage.section && other.start !== passage.start && QUALIFIER.test(other.text)) {
      const sentence = other.text.split(/(?<=[.!?])\s+|\n+/u).find(part => QUALIFIER.test(part));
      if (sentence) return sentence.trim().slice(0, maximum);
    }
  }
  return '';
}
