import { getOrLoadJson } from '../../core/json-cache.js';
import { auctionLeaderboardRepo } from './auction-leaderboard.repo.js';

// Same cache windows the ranked leaderboard uses: the board tolerates a few
// seconds of staleness, own-rank a little more since it changes less often.
const LIVE_LEADERBOARD_CACHE_TTL_SECONDS = 5;
const USER_RANK_CACHE_TTL_SECONDS = 30;

export const auctionLeaderboardService = {
  async getLeaderboard(limit: number, offset: number, country?: string) {
    const scope = country ? `country:${encodeURIComponent(country)}` : 'global';
    const key = `auction:leaderboard:v1:${scope}:${limit}:${offset}`;
    return getOrLoadJson(key, LIVE_LEADERBOARD_CACHE_TTL_SECONDS, () =>
      auctionLeaderboardRepo.listLeaderboard(limit, offset, country)
    );
  },

  async getUserRank(userId: string, country?: string) {
    const scope = country ? `country:${encodeURIComponent(country)}` : 'global';
    return getOrLoadJson(
      `auction:user-rank:v1:${scope}:${userId}`,
      USER_RANK_CACHE_TTL_SECONDS,
      () => auctionLeaderboardRepo.getUserRank(userId, country)
    );
  },
};
