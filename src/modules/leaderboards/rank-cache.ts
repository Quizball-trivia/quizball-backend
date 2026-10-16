import { deleteJsonCacheKeys } from '../../core/json-cache.js';
import { boardCacheScope, type BoardFilter } from './board-filter.js';

/** Own-rank cache keys, one per mode and board. */
export const userRankCacheKey = {
  ranked: (userId: string, filter: BoardFilter) => `ranked:user-rank:v3:${boardCacheScope(filter)}:${userId}`,
  auction: (userId: string, filter: BoardFilter) => `auction:user-rank:v2:${boardCacheScope(filter)}:${userId}`,
  ticTacToe: (userId: string, filter: BoardFilter) => `football-grid:user-rank:v2:${boardCacheScope(filter)}:${userId}`,
};

/** Forget a player's cached rank on boards they just left or joined. */
export async function invalidateAffiliationRanks(userId: string, filters: BoardFilter[]): Promise<void> {
  await deleteJsonCacheKeys(
    filters.flatMap((filter) => [
      userRankCacheKey.ranked(userId, filter),
      userRankCacheKey.auction(userId, filter),
      userRankCacheKey.ticTacToe(userId, filter),
    ]),
  );
}
