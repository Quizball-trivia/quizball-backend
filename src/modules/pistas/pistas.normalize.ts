const MARKS = /\p{M}+/gu;

/** Latin letters NFD does not decompose, folded the way players type them ("Østvik" → "ostvik", "Yılmazer" → "yilmazer"). */
const FOLD: Record<string, string> = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', đ: 'd', ð: 'd', ł: 'l', ı: 'i', þ: 'th', ħ: 'h' };
const FOLDABLE = new RegExp(`[${Object.keys(FOLD).join('')}]`, 'gu');

/**
 * How guesses and accepted answers are compared: NFD, combining marks stripped, lower case, every
 * character that is not a letter or digit turned into a space, spaces collapsed, trimmed.
 * "Dé Lorén", "de loren" and "DE-LORÉN" all become "de loren". No typo tolerance.
 */
export function normalizeAnswer(value: string): string {
  return value
    .normalize('NFD')
    .replace(MARKS, '')
    .toLowerCase()
    // Lower-casing can itself produce a combining mark (e.g. U+0130 in some inputs).
    .normalize('NFD')
    .replace(MARKS, '')
    .replace(FOLDABLE, (c) => FOLD[c])
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** True when `needle` (normalised) occurs in `haystack` (normalised) as whole words. */
export function containsWords(haystack: string, needle: string): boolean {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

const compact = (value: string): string => value.replace(/ /g, '');

/**
 * A normalised guess against normalised accepted answers. Spaces and punctuation never decide it: "L.O.R.A",
 * "NDala" (for N'Dala) and "vanderoort" match like "lora", "n dala" and "van der oort". Letters still must be exact.
 */
export function isAcceptedGuess(accepted: Iterable<string>, normalized: string): boolean {
  const target = compact(normalized);
  if (!target) return false;
  for (const answer of accepted) if (answer === normalized || compact(answer) === target) return true;
  return false;
}

/**
 * Whether two answer sets describe the same player: a display name of one is a display name or an accepted
 * answer of the other. A nickname shown on one side and accepted on the other overlaps; two players who only
 * share an accepted surname do not.
 */
export function samePlayer(a: { display: Iterable<string>; accepted: Iterable<string> }, b: { display: Iterable<string>; accepted: Iterable<string> }): boolean {
  const norm = (values: Iterable<string>) => new Set([...values].map(normalizeAnswer).filter((v) => v.length > 2));
  const [aDisplay, aAll, bDisplay, bAll] = [norm(a.display), norm([...a.display, ...a.accepted]), norm(b.display), norm([...b.display, ...b.accepted])];
  for (const name of aDisplay) if (bAll.has(name)) return true;
  for (const name of bDisplay) if (aAll.has(name)) return true;
  return false;
}
