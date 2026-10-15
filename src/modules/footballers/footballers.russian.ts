import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import { isCyrillicText } from './footballers.text.js';
import { buildRussianIndex, type ScopableIndex, type Universe, type UniversePlayer } from './footballers.universe.js';

/**
 * Russian names for the word games, as a versioned overlay shared by every release (wordgame_ru_versions /
 * wordgame_ru_names). A run or room freezes the version it started with and is judged with exactly that one; the active
 * version only decides what new runs and rooms freeze.
 */

/** The letters a run or room plays with. Absent on runs from before Russian names: Latin. */
export type ChainAlphabet = 'latin' | 'cyrillic';

const PAGE = 20_000;
const ACTIVE_TTL_MS = 60_000;
/** Versions held per process; an older one is loaded again when a run that froze it moves. */
const MAX_HELD = 2;
/** Loaded versions, least recently used first. Loads in flight are kept apart so eviction never duplicates one. */
const held = new Map<string, ScopableIndex>();
const loading = new Map<string, Promise<ScopableIndex>>();
let active: { version: string | null; checkedAt: number } = { version: null, checkedAt: 0 };

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

/** The version if this process already holds it: lets a caller under a transaction avoid a database read. */
export function heldRussianIndex(version: string): ScopableIndex | undefined {
  const index = held.get(version);
  if (index) {
    held.delete(version);
    held.set(version, index);
  }
  return index;
}

/** One version, loaded once per process (a failed load is not remembered); concurrent callers share the load. */
export function russianIndex(version: string): Promise<ScopableIndex> {
  const ready = heldRussianIndex(version);
  if (ready) return Promise.resolve(ready);
  const pending = loading.get(version);
  if (pending) return pending;
  const started = load(version).then((index) => {
    held.set(version, index);
    for (const id of held.keys()) {
      if (held.size <= MAX_HELD) break;
      held.delete(id);
    }
    return index;
  }).finally(() => {
    if (loading.get(version) === started) loading.delete(version);
  });
  loading.set(version, started);
  return started;
}

/** The version new runs and rooms freeze; null while Russian names are not switched on. */
export async function activeRussianVersion(now = Date.now()): Promise<string | null> {
  if (now - active.checkedAt < ACTIVE_TTL_MS) return active.version;
  const [row] = await sql<Array<{ version: string }>>`SELECT version FROM wordgame_ru_versions WHERE active LIMIT 1`;
  active = { version: row?.version ?? null, checkedAt: now };
  return active.version;
}

// Weak on both keys: an evicted version is freed even while a release that was viewed through it stays cached.
const views = new WeakMap<Universe, WeakMap<ScopableIndex, Universe>>();
/** The release's footballers under their Russian names (only those the release has). */
export function russianView(universe: Universe, index: ScopableIndex): Universe {
  let byIndex = views.get(universe);
  if (!byIndex) views.set(universe, (byIndex = new WeakMap()));
  let view = byIndex.get(index);
  if (!view) byIndex.set(index, (view = index.scoped(universe.releaseId, (pid) => universe.player(pid) !== undefined)));
  return view;
}

const combined = new WeakMap<Universe, Partial<Record<ChainAlphabet, Universe>>>();
/**
 * What a run or room is judged with: a typed name is read in the alphabet it was typed in (Cyrillic through the Russian
 * view, everything else exactly as before), while letters, starts and the names shown follow the frozen alphabet.
 * Without a Russian view this is the release itself, unchanged.
 */
export function judgingUniverse(universe: Universe, russian: Universe | null, alphabet: ChainAlphabet): Universe {
  if (!russian) return universe;
  // `russian` is memoised per (release, version), so it identifies the pair.
  let byAlphabet = combined.get(russian);
  if (!byAlphabet) combined.set(russian, (byAlphabet = {}));
  const cached = byAlphabet[alphabet];
  if (cached) return cached;
  const letters = alphabet === 'cyrillic' ? russian : universe;
  const view: Universe = {
    releaseId: universe.releaseId,
    size: letters.size,
    alphabet: letters.alphabet,
    player: (pid) => letters.player(pid) ?? universe.player(pid),
    starts: (pid) => letters.starts(pid),
    last: (pid) => letters.last(pid),
    starting: (letter) => letters.starting(letter),
    resolve: (text) => (isCyrillicText(text) ? russian.resolve(text) : universe.resolve(text)),
    pickAmong: (text, among) => (isCyrillicText(text) ? russian.pickAmong(text, among) : universe.pickAmong(text, among)),
  };
  byAlphabet[alphabet] = view;
  return view;
}

/** Tests only. */
export function forgetRussian(): void {
  held.clear();
  loading.clear();
  active = { version: null, checkedAt: 0 };
}
