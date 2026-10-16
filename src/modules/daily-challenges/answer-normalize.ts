/** Answer key for typed daily answers (Pass Chain aliases and guesses): no accents, no punctuation, lower case. */
export function normalizeAnswerString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return normalized || null;
}
