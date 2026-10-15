import { getOrLoadJson } from '../../core/json-cache.js';
import { logger } from '../../core/logger.js';
import { playPopularityRepo } from './play-popularity.repo.js';

/**
 * What the web orders the Play page by: for each game, how many different real people played it in the last 7
 * and 3 days. Counts only; no player is named. The numbers are read from the database once an hour and shared
 * by every replica through the JSON cache; each replica keeps its own copy for a few minutes. A caller is never
 * kept waiting for a refresh while there is a copy to give: the copy is served and the refresh runs behind it.
 * A failed refresh keeps the last good numbers and is not retried for a while, so public traffic never
 * multiplies a database problem. With nothing to serve the answer has no games and the web keeps its hand-made
 * order.
 */
export interface PlayPopularity {
  generated_at: string | null;
  games: Record<string, { players_7d: number; players_3d: number }>;
}

const SHARED_CACHE_SECONDS = 3_600;
/** How long a replica trusts its own copy before asking the shared cache again (by its own clock). */
const LOCAL_SECONDS = 300;
const RETRY_SECONDS = 120;
const EMPTY: PlayPopularity = { generated_at: null, games: {} };

let lastGood: { value: PlayPopularity; checkedAt: number } | null = null;
let retryAfter = 0;
let refreshing: Promise<PlayPopularity | null> | null = null;

async function load(): Promise<PlayPopularity> {
  const rows = await playPopularityRepo.load();
  return {
    generated_at: new Date().toISOString(),
    games: Object.fromEntries(rows.map((row) => [row.game, { players_7d: row.players_7d, players_3d: row.players_3d }])),
  };
}

/** One refresh at a time per replica; null when it failed. */
function refresh(): Promise<PlayPopularity | null> {
  refreshing ??= getOrLoadJson('public:play-popularity:v1', SHARED_CACHE_SECONDS, load)
    .then(
      (value) => {
        lastGood = { value, checkedAt: Date.now() };
        retryAfter = 0;
        return value;
      },
      (error: unknown) => {
        logger.warn({ error }, 'play popularity: load failed, serving the last good numbers if any');
        retryAfter = Date.now() + RETRY_SECONDS * 1_000;
        return null;
      },
    )
    .finally(() => { refreshing = null; });
  return refreshing;
}

export const playPopularityService = {
  async get(): Promise<PlayPopularity> {
    const now = Date.now();
    if (lastGood && now - lastGood.checkedAt < LOCAL_SECONDS * 1_000) return lastGood.value;
    if (retryAfter > now) return lastGood?.value ?? EMPTY;
    if (lastGood) {
      void refresh();
      return lastGood.value;
    }
    return (await refresh()) ?? EMPTY;
  },
};
