import type { Request, Response } from 'express';
import { rankedService } from './ranked.service.js';
import { usersRepo } from '../users/users.repo.js';
import type {
  LeaderboardResetBody,
  RankedLeaderboardQuery,
  RankedProfileResponse,
  RankedUserRankQuery,
} from './ranked.schemas.js';
import { parseStoredAvatarCustomization } from '../users/avatar-customization.js';
import { normalizeSupportedCountryCode } from '../../core/country.js';
import { resolveBoardFilter } from '../leaderboards/board-filter.js';
import { nextTargetOf } from '../leaderboards/board-response.js';

function computeTrend(wins: number, total: number): { trend: 'up' | 'down' | 'same'; trendValue: number } {
  if (total === 0) return { trend: 'same', trendValue: 0 };
  const losses = total - wins;
  if (wins > losses) return { trend: 'up', trendValue: wins };
  if (losses > wins) return { trend: 'down', trendValue: losses };
  return { trend: 'same', trendValue: 0 };
}

export const rankedController = {
  async getProfile(req: Request, res: Response): Promise<void> {
    const profile = await rankedService.ensureProfile(req.user!.id);
    const response: RankedProfileResponse = {
      rp: profile.rp,
      tier: profile.tier,
      placementStatus: profile.placement_status,
      placementPlayed: profile.placement_played,
      placementRequired: profile.placement_required,
      placementWins: profile.placement_wins,
      currentWinStreak: profile.current_win_streak,
      lastRankedMatchAt: profile.last_ranked_match_at,
    };
    res.json(response);
  },

  async getLeaderboard(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as RankedLeaderboardQuery;
    const { limit, offset, season } = query;

    const filter = await resolveBoardFilter(req, query);
    if (!filter) {
      res.json({ entries: [] });
      return;
    }

    const entries = season
      ? await rankedService.getArchivedLeaderboard(season, limit, offset, filter)
      : await rankedService.getLeaderboard(limit, offset, filter);

    const ranked = entries.map((entry, i) => {
      const { trendWins, trendTotal, ...rest } = entry;
      return {
        ...rest,
        avatarCustomization: parseStoredAvatarCustomization(entry.avatarCustomization),
        rank: offset + i + 1,
        ...computeTrend(trendWins, trendTotal),
      };
    });

    res.json({ entries: ranked });
  },

  async getUserRank(req: Request, res: Response): Promise<void> {
    const userId = req.user!.id;
    const query = req.validated.query as RankedUserRankQuery;
    const { season } = query;

    const user = await usersRepo.getById(userId);
    const filter = await resolveBoardFilter(req, query);
    if (!filter) {
      res.json(null);
      return;
    }

    if (season) {
      const rankInfo = await rankedService.getArchivedUserRank(season, userId, filter);
      if (!rankInfo) {
        res.json(null);
        return;
      }
      res.json({
        userId,
        username: user?.nickname ?? 'Player',
        avatarUrl: user?.avatar_url ?? null,
        avatarCustomization: parseStoredAvatarCustomization(user?.avatar_customization),
        country: normalizeSupportedCountryCode(user?.country),
        rp: rankInfo.rp,
        tier: rankInfo.tier,
        rank: rankInfo.rank,
        total: rankInfo.total,
        nextTarget: null,
        ...computeTrend(rankInfo.trendWins, rankInfo.trendTotal),
      });
      return;
    }

    const profile = await rankedService.ensureProfile(userId);
    if (profile.placement_status !== 'placed') {
      res.json(null);
      return;
    }

    const rankInfo = await rankedService.getUserRank(userId, filter);

    if (!rankInfo) {
      res.json(null);
      return;
    }

    res.json({
      userId,
      username: user?.nickname ?? 'Player',
      avatarUrl: user?.avatar_url ?? null,
      avatarCustomization: parseStoredAvatarCustomization(user?.avatar_customization),
      country: normalizeSupportedCountryCode(user?.country),
      rp: profile.rp,
      tier: profile.tier,
      rank: rankInfo.rank,
      total: rankInfo.total,
      nextTarget: nextTargetOf(rankInfo.rank, profile.rp, rankInfo.nextAbove),
      ...computeTrend(rankInfo.trendWins, rankInfo.trendTotal),
    });
  },

  async listSeasons(_req: Request, res: Response): Promise<void> {
    const seasons = await rankedService.listSeasons();
    const maxSeason = seasons.reduce((max, s) => Math.max(max, s.seasonNumber), 0);
    res.json({
      seasons: seasons.map((season) => ({
        id: season.id,
        seasonNumber: season.seasonNumber,
        startedAt: season.startedAt,
        endedAt: season.completedAt,
      })),
      currentSeasonNumber: maxSeason + 1,
    });
  },

  /**
   * POST /api/v1/admin/leaderboard/reset
   * Admin: archive current standings, then zero every real user's RP for an event.
   */
  async resetLeaderboard(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as LeaderboardResetBody;
    const result = await rankedService.resetLeaderboard({
      actorId: req.user!.id,
      notes: body.notes ?? null,
      seasonNumber: body.seasonNumber ?? null,
    });
    res.json(result);
  },
};
