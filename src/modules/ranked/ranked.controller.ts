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
    const { limit, offset, scope, season } = req.validated.query as RankedLeaderboardQuery;

    let country: string | undefined;
    if (scope === 'country') {
      const user = await usersRepo.getById(req.user!.id);
      country = user?.country ?? undefined;
    }

    const entries = season
      ? await rankedService.getArchivedLeaderboard(season, limit, offset, country)
      : await rankedService.getLeaderboard(limit, offset, country);

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
    const { scope, season } = req.validated.query as RankedUserRankQuery;

    const user = await usersRepo.getById(userId);
    const country = scope === 'country' ? (user?.country ?? undefined) : undefined;

    if (season) {
      const rankInfo = await rankedService.getArchivedUserRank(season, userId, country);
      if (!rankInfo) {
        res.json(null);
        return;
      }
      res.json({
        userId,
        username: user?.nickname ?? 'Player',
        avatarUrl: user?.avatar_url ?? null,
        avatarCustomization: parseStoredAvatarCustomization(user?.avatar_customization),
        country: user?.country ?? null,
        rp: rankInfo.rp,
        tier: rankInfo.tier,
        rank: rankInfo.rank,
        total: rankInfo.total,
        ...computeTrend(rankInfo.trendWins, rankInfo.trendTotal),
      });
      return;
    }

    const profile = await rankedService.ensureProfile(userId);
    if (profile.placement_status !== 'placed') {
      res.json(null);
      return;
    }

    const rankInfo = await rankedService.getUserRank(userId, country);

    if (!rankInfo) {
      res.json(null);
      return;
    }

    res.json({
      userId,
      username: user?.nickname ?? 'Player',
      avatarUrl: user?.avatar_url ?? null,
      avatarCustomization: parseStoredAvatarCustomization(user?.avatar_customization),
      country: user?.country ?? null,
      rp: profile.rp,
      tier: profile.tier,
      rank: rankInfo.rank,
      total: rankInfo.total,
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
