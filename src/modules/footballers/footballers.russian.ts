import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import { createActiveVersion, createVersionCache, overlayView, roomOverlayView } from './footballers.overlay.js';
import { buildRussianIndex, type ScopableIndex, type Universe, type UniversePlayer } from './footballers.universe.js';

export { judgingUniverse, RoomContentUnavailable, type ChainAlphabet } from './footballers.overlay.js';

/**
 * Russian names for the word games, as a versioned overlay shared by every release (wordgame_ru_versions /
 * wordgame_ru_names). A run or room freezes the version it started with and is judged with exactly that one; the active
 * version only decides what new runs and rooms freeze.
 */

const PAGE = 20_000;
const ACTIVE_TTL_MS = 60_000;
/** Versions held per process; an older one is loaded again when a run that froze it moves. */
const MAX_HELD = 2;

async function loadRows(version: string): Promise<UniversePlayer[]> {
  const rows: UniversePlayer[] = [];
  let after = '';
  for (;;) {
    const page = await sql<Array<{ pid: string; name_ru: string; game_name_ru: string; fame: number }>>`
      SELECT pid, name_ru, game_name_ru, fame FROM wordgame_ru_names
      WHERE version = ${version} AND pid > ${after} ORDER BY pid LIMIT ${PAGE}
    `;
    for (const row of page) rows.push({ pid: row.pid, name: row.name_ru, game: row.game_name_ru, fame: row.fame, aliases: [] });
    if (page.length < PAGE) return rows;
    after = page[page.length - 1].pid;
  }
}

async function load(version: string): Promise<ScopableIndex> {
  const started = Date.now();
  const [meta] = await sql<Array<{ players: number }>>`SELECT players FROM wordgame_ru_versions WHERE version = ${version}`;
  if (!meta) throw new Error('wordgame_ru_version_missing');
  const rows = await loadRows(version);
  if (rows.length !== meta.players) throw new Error('wordgame_ru_version_incomplete');
  const index = buildRussianIndex(version, rows);
  logger.info({ version, players: rows.length, ms: Date.now() - started }, 'Word game Russian names loaded');
  return index;
}

const cache = createVersionCache(load, MAX_HELD);
const active = createActiveVersion(async () => {
  const [row] = await sql<Array<{ version: string }>>`SELECT version FROM wordgame_ru_versions WHERE active LIMIT 1`;
  return row?.version ?? null;
}, ACTIVE_TTL_MS);

/** The version if this process already holds it: lets a caller under a transaction avoid a database read. */
export const heldRussianIndex = (version: string): ScopableIndex | undefined => cache.held(version);

/** One version, loaded once per process (a failed load is not remembered); concurrent callers share the load. */
export const russianIndex = (version: string): Promise<ScopableIndex> => cache.get(version);

/** The version new runs and rooms freeze; null while Russian names are not switched on. */
export const activeRussianVersion = (now = Date.now()): Promise<string | null> => active.get(now);

/** The active version as last read, without reading: for callers under a transaction (they warmed it before). */
export const knownActiveRussianVersion = (): string | null => active.known();

/**
 * A room's Russian names for its hydrator: the view it already holds, else the version from memory, else (only before
 * the match lock) a load. Under the lock a version not in memory is a retryable refusal, never a database read.
 */
export const roomRussianView = (universe: Universe, held: Universe | null | undefined, version: string, underLock: boolean): Promise<Universe> =>
  roomOverlayView(universe, held, version, underLock, cache);

/** The release's footballers under their Russian names (only those the release has). */
export const russianView = (universe: Universe, index: ScopableIndex): Universe => overlayView(universe, index);

/** Tests only. */
export function forgetRussian(): void {
  cache.forget();
  active.forget();
}
