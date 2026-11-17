import type { Universe } from './footballers.universe.js';

/**
 * Every footballer's exact names (name, known name, aliases; Latin and Georgian), shared by the answer matchers of the
 * games that judge against a short answer list (Pistas, Último, Clue Chain, Squad Spin, Pass Chain, Tenable managers).
 * A text that is, as typed, some footballer's name is never forgiven as a typo of somebody else: "Tamas Varnik" is not a
 * misspelt Tomas Varnik when both play. The word games' pickAmong has the same veto.
 */
export interface FootballerNames {
  /** Footballers whose name, known name or an alias is this text exactly (no typos), best known first. */
  holders(text: string): readonly string[];
}

// The release compares Latin and Georgian letters only and drops any other: "Саро Velmar" would read as "velmar".
const FOREIGN_LETTER = /[^\P{L}\p{Script=Latin}\p{Script=Georgian}]/u;

/** A text with a letter of another script holds nobody here (Russian names are not part of this index). */
export const footballerNamesOf = (universe: Pick<Universe, 'named'>): FootballerNames => ({
  holders: (text) => (FOREIGN_LETTER.test(text) ? [] : universe.named(text)),
});

let installed: FootballerNames | null = null;

/** The names loaded in this process, or null before the first load (the matchers then judge without the veto). */
export function currentFootballerNames(): FootballerNames | null {
  return installed;
}

/** Tests and offline tools. */
export function installFootballerNames(names: FootballerNames | null): void {
  installed = names;
}

/** Every footballer these name forms name exactly: who an answer is when the content has no footballer id. */
export function holdersOf(names: FootballerNames, forms: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const form of forms) for (const pid of names.holders(form)) out.add(pid);
  return out;
}

/** The text is, as typed, a footballer's name, and none of the footballers it names is the target. */
export function namesSomeoneElse(names: FootballerNames | null | undefined, text: string, isTarget: (pid: string) => boolean): boolean {
  if (!names) return false;
  const holders = names.holders(text);
  return holders.length > 0 && !holders.some(isTarget);
}

const GEORGIAN = /[\u10a0-\u10ff]/u;
/** A whole name: at least two words that are not initials ("T. Varnik" names every T. Varnik; "N'Daro Varnik" is whole). */
const isWholeName = (form: string): boolean =>
  form.trim().split(/[\s.]+/u).filter((word) => [...word].length > 1).length > 1;

/**
 * namesSomeoneElse for an answer known only by its name forms. The answer is whoever its whole names in the script the
 * text was typed in name (a bare surname names every namesake; a transliteration can merge two names); when those name
 * nobody, its one-word names that are not cut from a whole name. An answer no footballer holds is vetoed only when it is
 * a `person` (a manager who never played); a club or a country is not (a country's name may also be some footballer's).
 */
export function namesSomeoneElseThan(
  names: FootballerNames | null | undefined,
  text: string,
  forms: () => Iterable<string>,
  { person = false }: { person?: boolean } = {},
): boolean {
  if (!names || names.holders(text).length === 0) return false;
  const target = identityOf(names, text, forms());
  if (target.size === 0) return person;
  return namesSomeoneElse(names, text, (pid) => target.has(pid));
}

/** Who an answer known by these forms is, read for a text typed in a given script (see namesSomeoneElseThan). */
export function identityOf(names: FootballerNames, text: string, forms: Iterable<string>): Set<string> {
  const all = [...forms];
  const georgian = GEORGIAN.test(text);
  const sameScript = all.filter((form) => GEORGIAN.test(form) === georgian);
  const pool = sameScript.length > 0 ? sameScript : all;
  const whole = pool.filter(isWholeName);
  const target = holdersOf(names, whole.length > 0 ? whole : pool);
  if (target.size > 0 || whole.length === 0) return target;
  // Whole names the release does not know: a one-word name of its own ("Zinho") still says who it is; a surname cut
  // from a whole name ("Moss" of "Taro Arlan Moss") does not.
  const words = new Set(whole.flatMap((form) => form.toLowerCase().split(/[\s.]+/u)));
  return holdersOf(names, pool.filter((form) => !isWholeName(form) && !words.has(form.trim().toLowerCase())));
}
