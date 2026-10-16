import { sql } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { buildDirectory, withRussian, type Directory, type EntityKind, type TenableEntity } from './tenable.identify.js';
import { russianPinOf, russianRows, type RussianPin } from './tenable.russian.js';

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

/** Enough for a deploy window (old and new release) of each of the four kinds. */
const MAX_HELD = 8;
const held = new Map<string, Promise<Directory>>();
/**
 * Whether each release this process has loaded had Russian names, kept for the life of the process (it outlives the
 * LRU): a release evicted and loaded again keeps the first answer, so every day and match on this replica reads a
 * Cyrillic answer the same way until the next restart, even when a pin is written in between.
 */
const pins = new Map<string, Promise<RussianPin | null>>();

export const tenableDirectories = {
  /**
   * The directory of exactly this (kind, release), loaded once per process; never "the newest". A failed load is not
   * remembered. An empty release is refused: a list judged against nothing would mark every answer unknown. Russian
   * names written for a release after this process loaded it are read after its next restart.
   */
  get(kind: EntityKind, releaseId: string): Promise<Directory> {
    const key = `${kind}:${releaseId}`;
    const cached = held.get(key);
    if (cached) {
      held.delete(key);
      held.set(key, cached);
      return cached;
    }
    const loading = (async () => {
      const started = Date.now();
      const entities = await rows(kind, releaseId);
      if (entities.length === 0) throw new Error(`tenable_release_empty:${key}`);
      const latin = buildDirectory(kind, releaseId, entities);
      // The lookup itself is kept (two loads in flight share one answer); a failed one is not.
      let lookup = pins.get(key);
      if (!lookup) {
        const started = russianPinOf(sql, kind, releaseId);
        pins.set(key, (lookup = started));
        started.catch(() => { if (pins.get(key) === started) pins.delete(key); });
      }
      const pin = await lookup;
      const russian = pin ? await russianRows(sql, kind, releaseId, entities, pin) : null;
      const directory = russian ? withRussian(latin, buildDirectory(kind, releaseId, russian, 'cyrillic')) : latin;
      logger.info({ kind, releaseId, entities: directory.size, russian: Boolean(russian), ms: Date.now() - started }, 'Tenable directory loaded');
      return directory;
    })();
    held.set(key, loading);
    loading.catch(() => { if (held.get(key) === loading) held.delete(key); });
    while (held.size > MAX_HELD) held.delete(held.keys().next().value!);
    return loading;
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
    pins.clear();
  },
};
