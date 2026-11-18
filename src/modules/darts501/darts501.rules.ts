import { boardNamesake, isLatinText, isTypoReading, latinSurnames, onlyOne, sharedReadings, type Directory, type Identity } from '../tenable/tenable.identify.js';
import { isCyrillicText, isGreekText, normalizeName, normalizeNameCyrillic, normalizeNameGreek, typoBudget, withinEdits } from '../footballers/footballers.text.js';

/**
 * Football Darts 501, pure: everyone starts on 501, a dart is one named footballer of the category and his number in it
 * comes off. Shared by the solo daily and the room engine; no clock, no I/O.
 */
export const D501 = {
  start: 501,
  /** Landing anywhere from 0 down to this checks out. */
  floor: -10,
  /** A dart scores at most 180, as on a dartboard: a bigger number scores nothing. */
  maxDart: 180,
  /** Darts a solo run, or each seat in a room leg, gets. */
  darts: 10,
} as const;

/** Totals three darts cannot make: under pro rules they score nothing. */
export const BOGEYS: ReadonlySet<number> = new Set([163, 166, 169, 172, 173, 175, 176, 178, 179]);

export type ThrownVerdict = 'score' | 'checkout' | 'bust' | 'over180' | 'bogey' | 'miss' | 'time';
/**
 * Free answers use no dart. repeat: thrown already in this run or leg; ambiguous / unknown: the matcher cannot say who;
 * uncovered: a real footballer whose numbers our source does not have, so we cannot say he is not in the category.
 */
export type FreeVerdict = 'repeat' | 'ambiguous' | 'unknown' | 'uncovered';
export type DartVerdict = ThrownVerdict | FreeVerdict;

export const FREE: ReadonlySet<DartVerdict> = new Set<DartVerdict>(['repeat', 'ambiguous', 'unknown', 'uncovered']);

/** What a value does to `remaining`; null = not in the category (a miss). */
export function scoreDart(remaining: number, value: number | null, pro = false): { verdict: Exclude<ThrownVerdict, 'time'>; after: number } {
  if (value === null) return { verdict: 'miss', after: remaining };
  if (value > D501.maxDart) return { verdict: 'over180', after: remaining };
  if (pro && BOGEYS.has(value)) return { verdict: 'bogey', after: remaining };
  const after = remaining - value;
  if (after < D501.floor) return { verdict: 'bust', after: remaining };
  if (after <= 0) return { verdict: 'checkout', after };
  return { verdict: 'score', after };
}

/** The values that check out from `remaining` in one dart, or null when none can. */
export function checkoutWindow(remaining: number): { low: number; high: number } | null {
  if (remaining <= 0 || remaining > D501.maxDart) return null;
  return { low: remaining, high: Math.min(D501.maxDart, remaining - D501.floor) };
}

/** A category's numbers by footballer, built once per category object. */
export type Entries = ReadonlyMap<string, number>;
const indexed = new WeakMap<object, Entries>();
export function entriesOf(category: { entries: ReadonlyArray<{ eid: string; value: number }> }): Entries {
  let map = indexed.get(category);
  if (!map) indexed.set(category, (map = new Map(category.entries.map((e) => [e.eid, e.value]))));
  return map;
}

export interface Board {
  directory: Directory;
  /** Footballers our source has complete numbers for: only they can be a miss. */
  coverage: ReadonlySet<string>;
  entries: Entries;
}

/** Bumped with Darts' own reading of shared names (on top of the shared judge version): gap contexts carry it. */
export const DARTS_JUDGE_REVISION = 2;

export type Read =
  | { free: true; verdict: FreeVerdict; eid: string | null }
  | { free: false; verdict: Exclude<ThrownVerdict, 'time'>; eid: string; value: number | null; after: number };

/**
 * One answer. Who the text means is settled against the whole release first, and coverage is a property of the source
 * (a coverage set never changes once written), not of the category's entries: every verdict apart from the thrown ones is
 * the same whatever the category holds (no oracle). A picked suggestion's id
 * is the same as typing that footballer's full name.
 */
/**
 * A name (or a typo) the release cannot pin on one person, read against the category. Unless its best-known reading is
 * covered and better known than every uncovered one, in any script, it stays
 * ambiguous and free, whatever the category holds (the player may mean someone whose numbers we lack). A typo's readings
 * score only when exactly one of them is in the category; a name in another script spelt alike for several Latin names
 * is never read against it (it stays ambiguous). Otherwise its best-known reading in the category
 * not thrown yet scores, and with none it is a miss that uses the dart, named by the best-known reading (as a dominant
 * name is read as its best-known holder). Which way it goes depends on the release only: no free verdict here depends
 * on the category.
 */
function readShared(board: Board, used: ReadonlySet<string>, remaining: number, text: string, pro: boolean): Read | null {
  const holders = sharedReadings(board.directory, text);
  if (holders.length < 2) return null;
  // Owner call (2026-11-18): an exact name (never a typo) held by exactly one footballer in the category scores him,
  // even when another holder is uncovered. Trade-off accepted: the free "ambiguous" below now says no single holder is in.
  if (!isTypoReading(board.directory, text)) {
    const there = onlyOne(holders.filter((eid) => board.entries.has(eid)));
    if (there.length === 1 && !used.has(there[0]) && board.coverage.has(there[0])) {
      // Any doubt (not one surname for everyone it may name, or another entry may be meant) keeps the rule below as it was.
      if (oneSurname(board.directory, text, holders) === 'yes' && !meansAnotherEntry(board, text, there[0])) {
        const value = board.entries.get(there[0]) ?? null;
        return { free: false, eid: there[0], value, ...scoreDart(remaining, value, pro) };
      }
    }
  }
  if (!board.coverage.has(holders[0])) return null;
  const top = board.directory.entity(holders[0])?.fame ?? 0;
  if (holders.some((eid) => !board.coverage.has(eid) && (board.directory.entity(eid)?.fame ?? 0) >= top)) return null;
  const candidates = isTypoReading(board.directory, text) ? onlyOne(holders.filter((eid) => board.entries.has(eid))) : holders;
  const inside = candidates.find((eid) => board.entries.has(eid) && !used.has(eid));
  if (inside) {
    const value = board.entries.get(inside) ?? null;
    return { free: false, eid: inside, value, ...scoreDart(remaining, value, pro) };
  }
  // No open holder in the category is always a miss that uses the dart, even when one was thrown before: a free repeat
  // here would say whether another holder is in the category.
  return { free: false, eid: holders[0], value: null, ...scoreDart(remaining, null, pro) };
}

/** The directory and normaliser a text is read with: the same script priority as the composite directory. */
function scriptOf(directory: Directory, text: string): [Directory, (raw: string) => string] {
  const greek = isGreekText(text) ? directory.greek : undefined;
  const russian = !greek && isCyrillicText(text) ? directory.russian : undefined;
  return greek ? [greek, normalizeNameGreek] : russian ? [russian, normalizeNameCyrillic] : [directory, normalizeName];
}

/** True when a name ends with the key as whole words, spaced or written together. */
function endsWithWords(own: string, key: string): boolean {
  const words = own.split(' ');
  const joined = key.replace(/ /g, '');
  return words.some((_, i) => { const run = words.slice(i); return run.join(' ') === key || run.join('') === joined; });
}

/**
 * True when one of these names (one footballer's, normalised) is the key written together after something else
 * ("რატილოვრეკი" for "ლოვრეკი"): a one-word name ending with it that is not his surname as he is known (the last word of
 * none of his names of several words), so not "Farías" for "Arias".
 */
function writtenTogether(names: readonly string[], key: string): boolean {
  const joined = key.replace(/ /g, '');
  if ([...joined].length < 4) return false;
  const surnames = new Set(names.filter((name) => name.includes(' ')).map((name) => name.slice(name.lastIndexOf(' ') + 1)));
  return names.some((name) => !name.includes(' ') && name.length > joined.length && name.endsWith(joined) && !surnames.has(name) && surnames.size > 0);
}

/**
 * True when the text is one Latin surname for everyone it may name. Its holders share a Latin surname and, typed in Latin,
 * it is each one's own name, known name or surname (never only an alias some carry); and nobody in the release with a
 * name, known name or alias ending with it (an alias the index does not read on its own) has another Latin surname.
 */
function oneSurname(directory: Directory, text: string, holders: readonly string[]): 'yes' | 'no' | 'alias' | 'outsider' {
  const [first, ...rest] = holders.map((eid) => latinSurnames(directory, eid));
  const shared = new Set([...first].filter((surname) => rest.every((others) => others.has(surname))));
  if (shared.size === 0) return 'no';
  // Decided on the text as the release reads it: letters of another script around a Latin name do not skip it.
  const latinKey = normalizeName(text);
  if (/[a-z]/.test(latinKey) || isLatinText(text)) {
    const key = latinKey;
    const joined = key.replace(/ /g, '');
    // His own name or known name, also written without spaces ("TeoValcor"); never an alias.
    const ownName = (name: string) => { const n = normalizeName(name); return n === key || n.replace(/ /g, '') === joined; };
    const own = (eid: string) => { const e = directory.entity(eid); return Boolean(e) && (ownName(e!.name) || ownName(e!.known) || latinSurnames(directory, eid).has(key)); };
    if (!holders.every(own)) return 'alias';
  }
  const [script, normalize] = scriptOf(directory, text);
  const key = normalize(text);
  if (!key) return 'no';
  const names = (eid: string) => { const e = script.entity(eid); return e ? [e.name, e.known, ...e.aliases].map(normalize).filter(Boolean) : []; };
  // The index holds last words: the typed one, and those of the holders' names the text is written as (spaced or not).
  const compact = key.replace(/ /g, '');
  const lastWords = new Set([key.slice(key.lastIndexOf(' ') + 1), compact]);
  // Spaced or not, any end of it written together may be someone's last word ("ვანბრაკელი" / "... ვანბრა კელი").
  for (let i = 1; i <= compact.length - 3; i += 1) lastWords.add(compact.slice(i));
  for (const eid of holders) for (const name of names(eid)) if (endsWithWords(name, key)) lastWords.add(name.slice(name.lastIndexOf(' ') + 1));
  // Someone else only when none of his Latin names holds that surname as a word: "Fernando Llorente Torres" is a Torres.
  const other = (eid: string) => {
    if (holders.includes(eid)) return false;
    const entity = directory.entity(eid);
    const latin = entity ? [entity.name, entity.known, ...entity.aliases].filter(isLatinText).map(normalizeName) : [];
    return !latin.some((name) => name.split(' ').some((word) => shared.has(word))) && ![...latinSurnames(directory, eid)].some((surname) => shared.has(surname));
  };
  for (const word of lastWords) {
    for (const eid of script.tailHolders?.(word) ?? []) if (other(eid) && names(eid).some((name) => endsWithWords(name, key))) return 'outsider';
  }
  for (const eid of script.endingHolders?.(compact) ?? []) if (other(eid) && writtenTogether(names(eid), key)) return 'outsider';
  return 'yes';
}

/**
 * True when the text may mean another footballer in the category: one of his names (or aliases) holds it as a word or a
 * run of words, within a typo or sharing its stem ("ოსტრანდერ" / "ოსტრანდერი"), also written without spaces. Aliases are uneven
 * (one holds a surname only inside a full name), so the release's holders alone cannot rule him out.
 */
function meansAnotherEntry(board: Board, text: string, holder: string): boolean {
  const [directory, normalize] = scriptOf(board.directory, text);
  const key = normalize(text);
  const joined = key.replace(/ /g, '');
  const near = (typed: string, word: string) => typed === word || withinEdits(typed, word, typoBudget(typed.length))
    || (Math.min(typed.length, word.length) >= 3 && (word.startsWith(typed) || typed.startsWith(word)));
  for (const eid of board.entries.keys()) {
    const entity = eid === holder ? undefined : directory.entity(eid);
    if (!entity) continue;
    const all = [entity.name, entity.known, ...entity.aliases].map(normalize).filter(Boolean);
    if (writtenTogether(all, key)) return true;
    for (const own of all) {
      const words = own.split(' ');
      const run = words.some((_, i) => words.slice(i).some((__, j) => words.slice(i, i + j + 1).join('') === joined));
      if (` ${own} `.includes(` ${key} `) || near(key, own) || run) return true;
      if (words.some((word) => word.length >= 3 && near(key, word))) return true;
    }
  }
  return false;
}

export function readDart(board: Board, used: ReadonlySet<string>, remaining: number, text: string, picked: string | null, pro = false): Read {
  const byPick = Boolean(picked && board.directory.entity(picked));
  const identity: Identity = byPick ? { kind: 'entity', eid: picked! } : board.directory.identify(text);
  if (identity.kind === 'ambiguous' && !byPick) {
    const shared = readShared(board, used, remaining, text, pro);
    if (shared) return shared;
  }
  if (identity.kind !== 'entity') return { free: true, verdict: identity.kind, eid: null };
  let eid = identity.eid;
  if (used.has(eid)) return { free: true, verdict: 'repeat', eid };
  if (!board.coverage.has(eid)) return { free: true, verdict: 'uncovered', eid };
  // Only a dart that would miss is ever read as a namesake in the category, and only one not thrown yet: a failed
  // rescue still costs the dart, so no rescue ever turns into a free verdict.
  if (!byPick && !board.entries.has(eid)) {
    const there = boardNamesake(board.directory, text, eid, (e) => board.entries.has(e));
    if (there && !used.has(there)) eid = there;
  }
  const value = board.entries.get(eid) ?? null;
  return { free: false, eid, value, ...scoreDart(remaining, value, pro) };
}

/** Footballers not thrown yet who would check out from `remaining`; null when no single dart can. */
export function outs(entries: Entries, used: ReadonlySet<string>, remaining: number, pro = false): number | null {
  const window = checkoutWindow(remaining);
  if (!window) return null;
  let n = 0;
  for (const [eid, value] of entries) if (value >= window.low && value <= window.high && !used.has(eid) && !(pro && BOGEYS.has(value))) n += 1;
  return n;
}

/** Up to `limit` of them, closest to a bullseye first (ties by id, so every replica shows the same ones). */
export function finishes(entries: Entries, used: ReadonlySet<string>, remaining: number, limit: number, pro = false): Array<{ eid: string; value: number }> {
  const window = checkoutWindow(remaining);
  if (!window) return [];
  const out: Array<{ eid: string; value: number }> = [];
  for (const [eid, value] of entries) if (value >= window.low && value <= window.high && !used.has(eid) && !(pro && BOGEYS.has(value))) out.push({ eid, value });
  return out.sort((a, b) => a.value - b.value || (a.eid < b.eid ? -1 : a.eid > b.eid ? 1 : 0)).slice(0, limit);
}

/**
 * The solo board's order in one number (higher first): any checkout beats every run without one; then fewer darts, then
 * closer to 0. Without a checkout, the lower remaining is better.
 */
export function rankScore(checkedOut: boolean, darts: number, remaining: number): number {
  return checkedOut ? 1000 - 20 * darts - Math.abs(remaining) : D501.start - remaining;
}

/** The inverse of rankScore, for showing a board row. */
export function fromRankScore(score: number, darts: number): { checkedOut: boolean; remaining: number } {
  if (score >= 1000 - 20 * D501.darts - Math.abs(D501.floor)) return { checkedOut: true, remaining: Math.min(0, score - (1000 - 20 * darts)) };
  return { checkedOut: false, remaining: D501.start - score };
}
