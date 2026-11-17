import type { Universe } from './footballers.universe.js';

/**
 * Every footballer's exact names (name, known name, aliases; Latin and Georgian, and Greek when a Greek version is
 * active), shared by the answer matchers of the games that judge against a short answer list (Pistas, Último, Clue
 * Chain, Squad Spin, Pass Chain, Tenable managers). A text that is, as typed, some footballer's name is never forgiven
 * as a typo of somebody else: "Tamas Varnik" is not a misspelt Tomas Varnik when both play. The word games' pickAmong
 * has the same veto.
 */
export interface FootballerNames {
  /** Footballers whose name, known name or an alias is this text exactly (no typos), best known first. */
  holders(text: string): readonly string[];
  /**
   * True while the names this text is read with are not loaded (boot, a failed load): a typo cannot be told from
   * somebody else's name yet, so the matchers forgive none (exact answers still count).
   */
  pending?(text: string): boolean;
  /** When `pending` stops holding anything back by itself (a deadline), if it does. */
  pendingUntil?: number;
}

// The release compares Latin and Georgian letters only and drops any other: "Саро Velmar" would read as "velmar".
const FOREIGN_LETTER = /[^\P{L}\p{Script=Latin}\p{Script=Georgian}]/u;
const GREEK_LETTER = /\p{Script=Greek}/u;
const NOT_GREEK_LETTER = /[^\P{L}\p{Script=Greek}]/u;
/** Written in Greek letters only: read with the Greek names (a text mixing scripts holds nobody). */
const isGreekOnly = (text: string): boolean => GREEK_LETTER.test(text) && !NOT_GREEK_LETTER.test(text);

/**
 * A text with a letter of another script holds nobody here (Russian names are not part of this index); a Greek text
 * is read with the release's Greek names when it has them, and holds nobody otherwise. `greek: 'loading'` is an active
 * Greek version that could not be read yet: Greek texts are then pending.
 */
export const footballerNamesOf = (
  universe: Pick<Universe, 'named'>,
  greek: Pick<Universe, 'named'> | 'loading' | null = null,
  { pendingUntil = Infinity }: { pendingUntil?: number } = {},
): FootballerNames => ({
  holders: (text) => (isGreekOnly(text) ? (greek && greek !== 'loading' ? greek.named(text) : []) : FOREIGN_LETTER.test(text) ? [] : universe.named(text)),
  // Held back until `pendingUntil` at most, even if no later load replaces these names.
  ...(greek === 'loading' ? { pending: (text: string) => GREEK_LETTER.test(text) && Date.now() < pendingUntil, pendingUntil } : {}),
});

/** Before the first load of a process that loads the names: every text is pending. */
export const FOOTBALLER_NAMES_LOADING: FootballerNames = { holders: () => [], pending: () => true };

/** The names this text is read with are not loaded yet: no typo may be forgiven on it. */
export const namesPending = (names: FootballerNames | null | undefined, text: string): boolean => names?.pending?.(text) ?? false;

let installed: FootballerNames | null = null;
let awaited = false;

/**
 * The names loaded in this process. Null when the process never loads them (tests, tools) or there is no release: the
 * matchers then judge without the veto. FOOTBALLER_NAMES_LOADING while the loader has not installed them yet.
 */
export function currentFootballerNames(): FootballerNames | null {
  return installed ?? (awaited ? FOOTBALLER_NAMES_LOADING : null);
}

/** The loader is starting: until names are installed (or there are none to load) no typo is forgiven. */
export function awaitFootballerNames(): void {
  if (!installed) awaited = true;
}

/** The first load is taking too long (a read that never settles): judge without the veto, as before it existed. */
export function stopAwaitingFootballerNames(): void {
  awaited = false;
}

/** The loader, tests and offline tools. Null: judge without the veto (no release to load). */
export function installFootballerNames(names: FootballerNames | null): void {
  installed = names;
  awaited = false;
}

const MAX_RESPACED_LETTERS = 24;
/**
 * Two spaces anywhere; a third (a four-word name typed without spaces) up to 16 letters: a text costs at most ~600
 * lookups (cached per text), not the ~2,000 three spaces in 24 letters would.
 */
const addedSpaces = (letters: number): number => (letters <= 16 ? 3 : 2);
const RESPACED_CACHE = 2_000;
const respacedCache = new WeakMap<FootballerNames, Map<string, readonly string[]>>();

/**
 * Who the text names with its spaces placed anew ("TamasVarnik", "Tamas Varn ik" read as "Tamas Varnik"): spaces never
 * decide an answer, so they must not hide somebody else's name from the veto either. Every spacing (addedSpaces) of a
 * text of up to MAX_RESPACED_LETTERS letters, read together.
 */
function respacedHolders(names: FootballerNames, text: string): readonly string[] {
  const letters = [...text.normalize('NFC').replace(/[^\p{L}\p{M}\p{N}]+/gu, '')];
  if (letters.length < 2 || letters.length > MAX_RESPACED_LETTERS) return [];
  const key = letters.join('');
  let cache = respacedCache.get(names);
  if (!cache) respacedCache.set(names, (cache = new Map()));
  const hit = cache.get(key);
  if (hit) return hit;
  const found = new Set<string>(names.holders(key));
  const words: string[] = [];
  const place = (from: number, left: number) => {
    for (let cut = from + 1; cut < letters.length; cut += 1) {
      words.push(letters.slice(from, cut).join(''));
      for (const pid of names.holders(`${words.join(' ')} ${letters.slice(cut).join('')}`)) found.add(pid);
      if (left > 1) place(cut, left - 1);
      words.pop();
    }
  };
  place(0, addedSpaces(letters.length));
  const out = [...found];
  cache.set(key, out);
  if (cache.size > RESPACED_CACHE) cache.delete(cache.keys().next().value!);
  return out;
}

/** Who the text names: as typed, else with its spaces placed anew. */
export function holdersOfText(names: FootballerNames, text: string): readonly string[] {
  const own = names.holders(text);
  return own.length > 0 ? own : respacedHolders(names, text);
}

/**
 * Every footballer these name forms name exactly: who an answer is when the content has no footballer id. Forms are
 * read as written, never re-spaced: a one-word club or nickname split anew would name unrelated footballers.
 */
export function holdersOf(names: FootballerNames, forms: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const form of forms) for (const pid of names.holders(form)) out.add(pid);
  return out;
}

/**
 * Whether the text may be read with its spaces placed anew: only for a typo. A reading the answer's own words decide
 * (a surname, a span of its words, a shortened name) keeps the spacing it was read with, so an unrelated split of it
 * ("Amari lon" as "Ama Rilon") never refuses it.
 */
export interface VetoReading { respace?: boolean }

/** The text is, as typed (or for a typo, with its spaces placed anew), a footballer's name, and none of them is the target. */
export function namesSomeoneElse(names: FootballerNames | null | undefined, text: string, isTarget: (pid: string) => boolean, { respace = false }: VetoReading = {}): boolean {
  if (!names) return false;
  const holders = respace ? holdersOfText(names, text) : names.holders(text);
  return holders.length > 0 && !holders.some(isTarget);
}

const GEORGIAN = /[\u10a0-\u10ff]/u;
const scriptOf = (text: string): 'georgian' | 'greek' | 'latin' => (GEORGIAN.test(text) ? 'georgian' : GREEK_LETTER.test(text) ? 'greek' : 'latin');
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
  { person = false, respace = false }: { person?: boolean } & VetoReading = {},
): boolean {
  if (!names || (respace ? holdersOfText(names, text) : names.holders(text)).length === 0) return false;
  const target = identityOf(names, text, forms());
  if (target.size === 0) return person;
  return namesSomeoneElse(names, text, (pid) => target.has(pid), { respace });
}

/** Who an answer known by these forms is, read for a text typed in a given script (see namesSomeoneElseThan). */
export function identityOf(names: FootballerNames, text: string, forms: Iterable<string>): Set<string> {
  const all = [...forms];
  const script = scriptOf(text);
  const sameScript = all.filter((form) => scriptOf(form) === script);
  const pool = sameScript.length > 0 ? sameScript : all;
  const whole = pool.filter(isWholeName);
  const target = holdersOf(names, whole.length > 0 ? whole : pool);
  if (target.size > 0 || whole.length === 0) return target;
  // Whole names the release does not know: a one-word name of its own ("Zinho") still says who it is; a surname cut
  // from a whole name ("Moss" of "Taro Arlan Moss") does not.
  const words = new Set(whole.flatMap((form) => form.toLowerCase().split(/[\s.]+/u)));
  return holdersOf(names, pool.filter((form) => !isWholeName(form) && !words.has(form.trim().toLowerCase())));
}
