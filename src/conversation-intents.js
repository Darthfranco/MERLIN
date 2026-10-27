/** Complete appreciation only; commands, confirmations and quoted text stay with Meta. */
export function isPureAcknowledgment(message) {
  if (typeof message !== 'string' || /[\r\n"“”`]/u.test(message)) return false;
  const text = message.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ')
    .replace(/^merlin(?:,\s*|\s+)/u, '');
  return /^(?:(?:ok(?:ay)?|great|perfect|lovely|awesome)[, ]+)?(?:thanks(?: (?:so much|a lot|very much))?|thank you(?: (?:so much|very much))?|(?:i (?:really )?)?appreciate (?:it|that|your help)|cheers)(?:,? merlin)?[.!]*$/u.test(text);
}
