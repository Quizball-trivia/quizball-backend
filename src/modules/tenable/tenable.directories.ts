import { sql } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { buildDirectory, withRussian, type Directory, type EntityKind, type TenableEntity } from './tenable.identify.js';
import { russianPinOf, russianRows, type RussianPin } from './tenable.russian.js';
import { aliasPinsOf, withAliases } from './tenable.aliases.js';

const PAGE = 20_000;

/**
 * Players come from the word games' footballer release (one person keeps one id across games); managers, clubs and
 * nations from tenable_entities. Read in pages by id with plain statements (safe behind the transaction pooler).
 */
async function rows(kind: EntityKind, releaseId: string): Promise<TenableEntity[]> {
  const out: TenableEntity[] = [];
  let after = '';
  for (;;) {
    const page = kind === 'player'
      ? await sql<TenableEntity[]>`
          SELECT p.pid AS eid, p.name, p.game_name AS known, p.fame, p.aliases, m.qualifier
          FROM wordgame_players p LEFT JOIN tenable_player_meta m ON m.release_id = p.release_id AND m.pid = p.pid
          WHERE p.release_id = ${releaseId} AND p.pid > ${after} ORDER BY p.pid LIMIT ${PAGE}`
      : await sql<TenableEntity[]>`
          SELECT eid, name, known, fame, aliases, qualifier FROM tenable_entities
          WHERE release_id = ${releaseId} AND kind = ${kind} AND eid > ${after} ORDER BY eid LIMIT ${PAGE}`;
    out.push(...page);
    if (page.length < PAGE) return out;
    after = page[page.length - 1].eid;
  }
}

/** Directories nothing in use names (an old release looked up, a match that just ended): at most this many are kept. */
export const MAX_EXTRA = 4;
const held = new Map<string, Promise<Directory>>();
/**
 * What served days, enabled room lists and live matches name: never evicted. Each game's keeper pins its own pairs
 * (Tenable, Darts 501); the union is kept.
 */
const pinnedBy = new Map<string, Set<string>>();
let pinned = new Set<string>();
/** Least recently used first, pinned ones skipped. */
function evict(): void {
  let extra = [...held.keys()].filter((key) => !pinned.has(key)).length;
  for (const key of held.keys()) {
    if (extra <= MAX_EXTRA) return;
    if (pinned.has(key)) continue;
    held.delete(key);
    extra -= 1;
  }
}
/** A failed load is answered with its error for this long before the database is asked again (an incident is not multiplied by traffic). */
export const FAILED_RETRY_MS = 5_000;
const failed = new Map<string, { until: number; error: unknown }>();
/**
 * Whether each release this process has loaded had Russian names, kept for the life of the process (it outlives
 * eviction): a release evicted and loaded again keeps the first answer, so every day and match on this replica reads a
 * Cyrillic answer the same way until the next restart, even when a Russian pin is written in between.
 */
const russianPins = new Map<string, Promise<RussianPin | null>>();
/** The same for the alias pins (Portuguese spellings): read once per (kind, release) for the process lifetime. */
const aliasPins = new Map<string, Promise<string[]>>();

export const tenableDirectories = {
  /**
   * The directory of exactly this (kind, release), loaded once per process; never "the newest". A failed load is
   * remembered for FAILED_RETRY_MS only. An empty release is refused: a list judged against nothing would mark every
   * answer unknown. Russian names written for a release after this process loaded it are read after its next restart.
   */
  get(kind: EntityKind, releaseId: string): Promise<Directory> {
    const key = `${kind}:${releaseId}`;
    const cached = held.get(key);
    if (cached) {
      held.delete(key);
      held.set(key, cached);
      return cached;
    }
    const failure = failed.get(key);
    if (failure && failure.until > Date.now()) return Promise.reject(failure.error);
    failed.delete(key);
    const loading = (async () => {
      const started = Date.now();
      const own = await rows(kind, releaseId);
      if (own.length === 0) throw new Error(`tenable_release_empty:${key}`);
      let pins = aliasPins.get(key);
      if (!pins) {
        const asked = aliasPinsOf(sql, kind, releaseId);
        aliasPins.set(key, (pins = asked));
        asked.catch(() => { if (aliasPins.get(key) === asked) aliasPins.delete(key); });
      }
      const entities = await withAliases(sql, kind, own, await pins);
      const fetched = Date.now();
      const latin = buildDirectory(kind, releaseId, entities);
      // The lookup itself is kept (two loads in flight share one answer); a failed one is not.
      let lookup = russianPins.get(key);
      if (!lookup) {
        const asked = russianPinOf(sql, kind, releaseId);
        russianPins.set(key, (lookup = asked));
        asked.catch(() => { if (russianPins.get(key) === asked) russianPins.delete(key); });
      }
      const pin = await lookup;
      const russian = pin ? await russianRows(sql, kind, releaseId, entities, pin) : null;
      const directory = russian ? withRussian(latin, buildDirectory(kind, releaseId, russian, 'cyrillic')) : latin;
      const done = Date.now();
      logger.info({ kind, releaseId, entities: directory.size, russian: Boolean(russian), ms: done - started, fetchMs: fetched - started, buildMs: done - fetched }, 'Tenable directory loaded');
      return directory;
    })();
    held.set(key, loading);
    loading.catch((error: unknown) => {
      if (held.get(key) !== loading) return;
      held.delete(key);
      failed.set(key, { until: Date.now() + FAILED_RETRY_MS, error });
    });
    evict();
    return loading;
  },

  /** The (kind, release) pairs `source` uses now; pairs no source pins any more become ordinary extras. */
  pin(pairs: ReadonlyArray<{ kind: EntityKind; release: string }>, source = 'tenable'): void {
    pinnedBy.set(source, new Set(pairs.map((p) => `${p.kind}:${p.release}`)));
    pinned = new Set([...pinnedBy.values()].flatMap((keys) => [...keys]));
    evict();
  },

  /** Loads what served days and live matches pin, before they need it (boot, enable): gameplay never waits on a cold load. */
  async warm(pins: ReadonlyArray<{ kind: EntityKind; release: string }>): Promise<void> {
    const unique = [...new Map(pins.map((p) => [`${p.kind}:${p.release}`, p])).values()];
    await Promise.all(unique.map((p) => tenableDirectories.get(p.kind, p.release).catch((error: unknown) => logger.error({ err: error, ...p }, 'Tenable directory warm-up failed'))));
  },

  /** True when this (kind, release) is loaded in this process already. */
  loaded(kind: EntityKind, releaseId: string): boolean {
    return held.has(`${kind}:${releaseId}`);
  },

  /** Tests only. */
  clear(): void {
    held.clear();
    failed.clear();
    pinned = new Set();
    pinnedBy.clear();
    russianPins.clear();
  },
};
