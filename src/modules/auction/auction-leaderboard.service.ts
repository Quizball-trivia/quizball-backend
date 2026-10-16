import { getOrLoadJson } from '../../core/json-cache.js';
import { boardCacheScope, GLOBAL_BOARD, type BoardFilter } from '../leaderboards/board-filter.js';
import { userRankCacheKey } from '../leaderboards/rank-cache.js';
import { auctionLeaderboardRepo } from './auction-leaderboard.repo.js';

// Same cache windows the ranked leaderboard uses: the board tolerates a few
// seconds of staleness, own-rank a little more since it changes less often.
const LIVE_LEADERBOARD_CACHE_TTL_SECONDS = 5;
const USER_RANK_CACHE_TTL_SECONDS = 30;

export const auctionLeaderboardService = {
  async getLeaderboard(limit: number, offset: number, filter: BoardFilter = GLOBAL_BOARD) {
    const key = `auction:leaderboard:v2:${boardCacheScope(filter)}:${limit}:${offset}`;
    return getOrLoadJson(key, LIVE_LEADERBOARD_CACHE_TTL_SECONDS, () =>
      auctionLeaderboardRepo.listLeaderboard(limit, offset, filter)
    );
  },

  async getUserRank(userId: string, filter: BoardFilter = GLOBAL_BOARD) {
    return getOrLoadJson(
      userRankCacheKey.auction(userId, filter),
      USER_RANK_CACHE_TTL_SECONDS,
      async () => {
        const rank = await auctionLeaderboardRepo.getUserRank(userId, filter);
        if (!rank) return null;
        const above = rank.rank > 1 ? await auctionLeaderboardRepo.getNextAbove(userId, filter) : null;
        return { ...rank, nextAbove: above };
      }
    );
  },
};
