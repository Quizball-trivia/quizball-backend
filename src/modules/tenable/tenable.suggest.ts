import { AppError } from '../../core/errors.js';
import { tenableDailyContent, tenableRoomPairs } from '../tenable-daily/tenable-daily.service.js';
import { tenableDirectories } from './tenable.directories.js';
import { ENTITY_KINDS, SUGGEST_LIMIT, type EntityKind, type Suggestion } from './tenable.identify.js';
import { isCyrillicText } from '../footballers/footballers.text.js';
import { ALIAS_KINDS } from './tenable.aliases.js';
import { displayNamesReady, isNameLocale, shownName } from './tenable.names.js';

const ALLOWED_REFRESH_MS = 60_000;
/** A pair not in the set re-reads it at most this often (a list seeded or dealt a moment ago). */
const MISS_REFRESH_MS = 5_000;
let allowed: { at: number; keys: Set<string> } | null = null;

/**
 * The (kind, release) pairs some served day, enabled room list or live match uses: suggestions are served for these
 * only, so a caller can never make a replica load a release nothing plays on. A live match keeps its releases after
 * its lists leave the pool.
 */
async function allowedPairs(key: string): Promise<Set<string>> {
  const age = allowed ? Date.now() - allowed.at : Infinity;
  if (allowed && (age < MISS_REFRESH_MS || (age < ALLOWED_REFRESH_MS && allowed.keys.has(key)))) return allowed.keys;
  const keys = new Set<string>();
  for (const day of (await tenableDailyContent.get()).values()) keys.add(`${day.list.kind}:${day.list.release}`);
  for (const row of await tenableRoomPairs()) keys.add(`${row.kind}:${row.release}`);
  allowed = { at: Date.now(), keys };
  return keys;
}

/**
 * Names that start with what was typed, best known first, from the whole release of that kind: the same answer whatever
 * any list holds. Unknown pairs get an empty list (never an error that would say which releases exist); a release that
 * cannot be loaded right now is a 503, never an empty answer someone would cache. A pt/de `locale` labels clubs and
 * nations with the names that language is shown (which names are found does not depend on it).
 */
export async function suggest(kind: string, release: string, query: string, locale?: string): Promise<Suggestion[]> {
  if (!(ENTITY_KINDS as readonly string[]).includes(kind)) return [];
  const key = `${kind}:${release}`;
  if (!tenableDirectories.loaded(kind as EntityKind, release) && !(await allowedPairs(key)).has(key)) return [];
  const directory = await tenableDirectories.get(kind as EntityKind, release).catch(() => null);
  if (!directory) throw new AppError('Suggestions are unavailable right now', 503);
  const items = directory.suggest(query, SUGGEST_LIMIT);
  // Russian queries are answered in Russian already; people keep their names.
  if (!isNameLocale(locale) || !ALIAS_KINDS.has(kind as EntityKind) || isCyrillicText(query)) return items;
  // A response is cached for an hour: never label it from a cache that has not been read yet.
  await displayNamesReady();
  const labelled = items.map((s) => ({ ...s, label: shownName(directory, s.eid, locale) ?? s.label }));
  // Two options that would look the same keep their own names.
  const look = (s: Suggestion) => `${s.label.toLocaleLowerCase()}|${s.qualifier ?? ''}`;
  const seen = new Map<string, number>();
  for (const s of labelled) seen.set(look(s), (seen.get(look(s)) ?? 0) + 1);
  return labelled.map((s, i) => (seen.get(look(s))! > 1 && s.label !== items[i].label ? items[i] : s));
}
