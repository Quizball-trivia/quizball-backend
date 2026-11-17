import { foldLatin } from '../../lib/latin-fold.js';
import { currentFootballerNames, namesSomeoneElseThan, type FootballerNames } from '../footballers/footballers.names.js';
import { withinEdits } from '../footballers/footballers.text.js';

const MARKS = /\p{M}+/gu;

/**
 * How guesses and accepted answers are compared: NFD, combining marks stripped, lower case, every
 * character that is not a letter or digit turned into a space, spaces collapsed, trimmed.
 * "Dé Lorén", "de loren" and "DE-LORÉN" all become "de loren".
 */
export function normalizeAnswer(value: string): string {
  const lowered = value
    .normalize('NFD')
    .replace(MARKS, '')
    .toLowerCase()
    // Lower-casing can itself produce a combining mark (e.g. U+0130 in some inputs).
    .normalize('NFD')
    .replace(MARKS, '');
  return foldLatin(lowered)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** True when `needle` (normalised) occurs in `haystack` (normalised) as whole words. */
export function containsWords(haystack: string, needle: string): boolean {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

const compact = (value: string): string => value.replace(/ /g, '');
// NFKC: "７" is 7, and "Ⅱ" is the letters "II" (as typed in Latin), not a number.
const digitsOf = (value: string): string => value.normalize('NFKC').replace(/\P{N}/gu, '');

/** Typos forgiven by the guess's length (letters, spaces ignored): none under five, one from five, two from nine. */
export const typoToleranceFor = (letters: number): number => (letters >= 9 ? 2 : letters >= 5 ? 1 : 0);
/** Only an accepted answer of five letters or more absorbs a typo: a short one sits one edit from unrelated names. */
const TYPO_MIN_KEY = 5;

/**
 * A normalised guess against normalised accepted answers. Spaces and punctuation never decide it: "L.O.R.A",
 * "NDala" (for N'Dala) and "vanderoort" match like "lora", "n dala" and "van der oort". Then a long name without its
 * first word ("arno pellegrini" for "juan arno pellegrini"), then a typo (typoToleranceFor). The round has one hidden answer, so nothing is
 * ambiguous; but neither a typo nor a shortened name credits a guess that is, as typed, another footballer's name.
 */
export function isAcceptedGuess(accepted: Iterable<string>, normalized: string, names: FootballerNames | null = currentFootballerNames()): boolean {
  const target = compact(normalized);
  if (!target) return false;
  const answers = [...accepted];
  for (const answer of answers) if (answer === normalized || compact(answer) === target) return true;
  // Every Pistas answer is a footballer: one the release does not know is still not the footballer typed.
  const someoneElse = (text: string) => namesSomeoneElseThan(names, text, () => answers, { person: true });
  if (someoneElse(normalized)) return false;
  for (const answer of answers) {
    const words = answer.split(' ');
    // Read with its spaces, however it was typed: "arlanmoss" is the name "arlan moss".
    const rest = words.slice(1).join(' ');
    if (words.length > 2 && compact(rest) === target) return !someoneElse(rest);
  }
  const tolerance = typoToleranceFor(target.length);
  if (tolerance === 0) return false;
  // A number is never a typo ("Número 1" is not "Número 0").
  const digits = digitsOf(target);
  return answers.some((answer) => {
    const key = compact(answer);
    return key.length >= TYPO_MIN_KEY && digitsOf(key) === digits && withinEdits(target, key, tolerance);
  });
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
