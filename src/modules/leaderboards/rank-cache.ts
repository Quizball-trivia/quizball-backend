import { deleteJsonCacheKeys } from '../../core/json-cache.js';
import { boardCacheScope, type BoardFilter } from './board-filter.js';

/** Own-rank cache keys, one per mode and board. */
export const userRankCacheKey = {
  ranked: (userId: string, filter: BoardFilter) => `ranked:user-rank:v4:${boardCacheScope(filter)}:${userId}`,
  auction: (userId: string, filter: BoardFilter) => `auction:user-rank:v2:${boardCacheScope(filter)}:${userId}`,
  ticTacToe: (userId: string, filter: BoardFilter) => `football-grid:user-rank:v2:${boardCacheScope(filter)}:${userId}`,
};

/**
 * Ranked live-board keys shared by every replica. Their versions moved when
 * country and club boards started ranking bots after real players, so replicas
 * on either side of a rolling deploy never read each other's order.
 */
export const rankedBoardCacheKey = {
  list: (filter: BoardFilter, limit: number, offset: number) =>
    `ranked:leaderboard:v3:${boardCacheScope(filter)}:${limit}:${offset}`,
  nextAbove: (userId: string, filter: BoardFilter) => `ranked:next-above:v2:${boardCacheScope(filter)}:${userId}`,
};

/**
 * Every key that may hold a player's ranked rank on a board. v3 is still read
 * by replicas on the previous release during a rolling deploy; clearing it
 * keeps their copy from outliving a match this release settled.
 */
export function rankedUserRankKeys(userId: string, filter: BoardFilter): string[] {
  return [userRankCacheKey.ranked(userId, filter), `ranked:user-rank:v3:${boardCacheScope(filter)}:${userId}`];
}

/** Forget a player's cached rank on boards they just left or joined. */
export async function invalidateAffiliationRanks(userId: string, filters: BoardFilter[]): Promise<void> {
  await deleteJsonCacheKeys(
    filters.flatMap((filter) => [
      ...rankedUserRankKeys(userId, filter),
      userRankCacheKey.auction(userId, filter),
      userRankCacheKey.ticTacToe(userId, filter),
    ]),
  );
}
