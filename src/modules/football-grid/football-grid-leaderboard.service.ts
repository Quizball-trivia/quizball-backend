import { getOrLoadJson } from '../../core/json-cache.js';
import { boardCacheScope, GLOBAL_BOARD, type BoardFilter } from '../leaderboards/board-filter.js';
import { userRankCacheKey } from '../leaderboards/rank-cache.js';
import { footballGridLeaderboardRepo } from './football-grid-leaderboard.repo.js';

const LIVE_LEADERBOARD_CACHE_TTL_SECONDS = 5;
const USER_RANK_CACHE_TTL_SECONDS = 5;

export const footballGridLeaderboardService = {
  async getLeaderboard(limit: number, offset: number, filter: BoardFilter = GLOBAL_BOARD) {
    return getOrLoadJson(
      `football-grid:leaderboard:v2:${boardCacheScope(filter)}:${limit}:${offset}`,
      LIVE_LEADERBOARD_CACHE_TTL_SECONDS,
      () => footballGridLeaderboardRepo.listLeaderboard(limit, offset, filter),
    );
  },

  async getUserRank(userId: string, filter: BoardFilter = GLOBAL_BOARD) {
    return getOrLoadJson(
      userRankCacheKey.ticTacToe(userId, filter),
      USER_RANK_CACHE_TTL_SECONDS,
      async () => {
        const rank = await footballGridLeaderboardRepo.getUserRank(userId, filter);
        if (!rank) return null;
        const above = rank.rank > 1 ? await footballGridLeaderboardRepo.getNextAbove(userId, filter) : null;
        return { ...rank, nextAbove: above };
      },
    );
  },
};
