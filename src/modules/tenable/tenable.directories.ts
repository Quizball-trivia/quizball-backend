import { sql } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { buildDirectory, type Directory, type EntityKind, type TenableEntity } from './tenable.identify.js';

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
/** What served days, enabled room lists and live matches name: never evicted (see the keeper in tenable-daily.service). */
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

export const tenableDirectories = {
  /**
   * The directory of exactly this (kind, release), loaded once per process; never "the newest". A failed load is
   * remembered for FAILED_RETRY_MS only. An empty release is refused: a list judged against nothing would mark every
   * answer unknown.
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
      const entities = await rows(kind, releaseId);
      if (entities.length === 0) throw new Error(`tenable_release_empty:${key}`);
      const directory = buildDirectory(kind, releaseId, entities);
      logger.info({ kind, releaseId, entities: directory.size, ms: Date.now() - started }, 'Tenable directory loaded');
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

  /** The (kind, release) pairs in use now; the previous set's pairs become ordinary extras. */
  pin(pairs: ReadonlyArray<{ kind: EntityKind; release: string }>): void {
    pinned = new Set(pairs.map((p) => `${p.kind}:${p.release}`));
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
  },
};
