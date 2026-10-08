/**
 * Name handling shared by the word games (name chain, played for both). One accent-insensitive Latin alphabet, so a
 * game never depends on the player's keyboard: a name in Ö starts with O, and Turkish I / İ / ı / i are one letter. Georgian
 * letters are kept as they are (a name typed in Georgian matches a Georgian alias).
 */
const FOLD: Record<string, string> = { 'ß': 'ss', 'ø': 'o', 'đ': 'd', 'ł': 'l', 'æ': 'ae', 'œ': 'oe', 'ð': 'd', 'þ': 'th' };

/** Lower-case, accent-free, single-spaced: the form names are compared in. */
export function normalizeName(raw: string): string {
  const lowered = raw.replace(/[İIı]/g, 'i').toLowerCase().replace(/[ßøđłæœðþ]/g, (ch) => FOLD[ch] ?? ch);
  return lowered.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ა-ჿ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const lettersOf = (name: string): string => normalizeName(name).replace(/[^a-z]/g, '');

/** The letter a name starts with, in the games' alphabet (upper-case). */
export const firstLetter = (name: string): string => lettersOf(name).charAt(0).toUpperCase();
export const lastLetter = (name: string): string => lettersOf(name).slice(-1).toUpperCase();

/** True when the two normalised strings differ by at most one insertion, deletion, substitution or swap of neighbours. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const gap = a.length - b.length;
  if (gap > 1 || gap < -1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (gap === 0) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return gap === 1 ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** Edits forgiven for a name of this length: none on very short names, two on long ones. */
export const typoBudget = (length: number): number => (length < 5 ? 0 : length < 9 ? 1 : 2);

export function withinEdits(a: string, b: string, budget: number): boolean {
  if (a === b) return true;
  if (budget <= 0 || Math.abs(a.length - b.length) > budget) return false;
  if (budget === 1) return withinOneEdit(a, b);
  // Two edits: plain edit distance with an early exit (names are short).
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, row[j]);
    }
    if (best > budget) return false;
    previous = row;
  }
  return previous[b.length] <= budget;
}

/** In an open search over every footballer, typos are only forgiven on names long enough that one edit cannot turn them into somebody else. */
export const TYPO_MIN_LENGTH = 6;

const NAME_SUFFIXES = new Set(['junior', 'jr', 'filho', 'neto', 'ii', 'iii']);

/** The last name word that is not a suffix ("Farran" for "Pim Farran Junior"). */
export function surnameOf(name: string): string {
  const words = normalizeName(name).split(' ').filter(Boolean);
  while (words.length > 1 && NAME_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words[words.length - 1] ?? '';
}
