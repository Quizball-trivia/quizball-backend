import { getOrLoadJson } from '../../core/json-cache.js';
import { footballGridLeaderboardRepo } from './football-grid-leaderboard.repo.js';

const LIVE_LEADERBOARD_CACHE_TTL_SECONDS = 5;
const USER_RANK_CACHE_TTL_SECONDS = 5;

export const footballGridLeaderboardService = {
  async getLeaderboard(limit: number, offset: number, country?: string) {
    const scope = country
      ? `country:${encodeURIComponent(country)}`
      : 'global';
    return getOrLoadJson(
      `football-grid:leaderboard:v1:${scope}:${limit}:${offset}`,
      LIVE_LEADERBOARD_CACHE_TTL_SECONDS,
      () => footballGridLeaderboardRepo.listLeaderboard(limit, offset, country),
    );
  },

  async getUserRank(userId: string, country?: string) {
    const scope = country
      ? `country:${encodeURIComponent(country)}`
      : 'global';
    return getOrLoadJson(
      `football-grid:user-rank:v1:${scope}:${userId}`,
      USER_RANK_CACHE_TTL_SECONDS,
      () => footballGridLeaderboardRepo.getUserRank(userId, country),
    );
  },
};
