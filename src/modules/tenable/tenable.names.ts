import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import { ALIAS_KINDS } from './tenable.aliases.js';
import { AppError } from '../../core/errors.js';
import { displayName, type Directory } from './tenable.identify.js';

/** Languages whose club and nation names live in tenable_display_names (Russian has its own directory). */
export const NAME_LOCALES = ['pt', 'de'] as const;
export type NameLocale = (typeof NAME_LOCALES)[number];
export const isNameLocale = (locale: string | undefined): locale is NameLocale => (NAME_LOCALES as readonly string[]).includes(locale ?? '');

export const DISPLAY_NAMES_REFRESH_MS = 5 * 60_000;
let loaded: Map<string, string> | null = null;
let loading: Promise<void> | null = null;
/** Per directory: whether it shows `${locale}:${eid}:${name}` (the answer never changes for a loaded release). */
const verdicts = new WeakMap<Directory, Map<string, boolean>>();

/**
 * Reads tenable_display_names (a few thousand rows) outside any caller's transaction; a failure keeps what was there.
 * Called at boot and on a timer (see the Tenable keeper), never from a view.
 */
export function refreshDisplayNames(): Promise<void> {
  loading ??= (async () => {
    try {
      const rows = await sql<Array<{ locale: string; kind: string; eid: string; name: string }>>`SELECT locale, kind, eid, name FROM tenable_display_names`;
      loaded = new Map(rows.map((r) => [`${r.locale}:${r.kind}:${r.eid}`, r.name]));
    } catch (error) {
      logger.warn({ err: error }, 'Tenable display names could not be read');
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/**
 * Resolves once the names have been read, for callers that hold no lock and whose answer is cached for an hour: while
 * they cannot be read at all, a 503 (never cached), not an answer in English.
 */
export async function displayNamesReady(): Promise<void> {
  if (!loaded) await refreshDisplayNames();
  if (!loaded) throw new AppError('Names are unavailable right now', 503);
}

/**
 * A translated name is shown only when this release reads it as this same entity, and no other entity of it is called
 * that: the game never shows a name it would not accept, nor two answers that look the same.
 */
export function shows(directory: Directory, eid: string, name: string): boolean {
  const read = directory.identify(name);
  if (read.kind !== 'entity' || read.eid !== eid) return false;
  return directory.named(name).every((other) => other === eid);
}

/**
 * The name to show for an entity in a language, from memory only (callers may hold a transaction or a match lock):
 * Russian from the release's Russian names, pt/de club and nation names from tenable_display_names when the release
 * accepts them (see `shows`); anything else is the release's own name.
 */
export function shownName(directory: Directory, eid: string, locale: string | undefined): string | null {
  if (locale === 'ru') return displayName(directory, eid, true);
  const own = directory.entity(eid)?.name ?? null;
  if (own === null || !isNameLocale(locale) || !ALIAS_KINDS.has(directory.kind)) return own;
  const local = loaded?.get(`${locale}:${directory.kind}:${eid}`);
  if (!local || local === own) return own;
  let memo = verdicts.get(directory);
  if (!memo) verdicts.set(directory, (memo = new Map()));
  const key = `${locale}:${eid}:${local}`;
  let ok = memo.get(key);
  if (ok === undefined) memo.set(key, (ok = shows(directory, eid, local)));
  return ok ? local : own;
}

/** Tests only. */
export function setDisplayNames(rows: ReadonlyArray<{ locale: string; kind: string; eid: string; name: string }> | null): void {
  loaded = rows && new Map(rows.map((r) => [`${r.locale}:${r.kind}:${r.eid}`, r.name]));
  loading = null;
}
