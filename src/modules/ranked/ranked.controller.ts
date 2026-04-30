import type { Request, Response } from 'express';
import { rankedService } from './ranked.service.js';
import { usersRepo } from '../users/users.repo.js';
import type { RankedProfileResponse } from './ranked.schemas.js';
import { avatarCustomizationSchema } from '../users/avatar-customization.js';

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
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;
    const scope = (req.query.scope as string) || 'global';

    let country: string | undefined;
    if (scope === 'country') {
      const user = await usersRepo.getById(req.user!.id);
      country = user?.country ?? undefined;
    }

    const entries = await rankedService.getLeaderboard(limit, offset, country);

    const ranked = entries.map((entry, i) => {
      const { trendWins, trendTotal, ...rest } = entry;
      return {
        ...rest,
        avatarCustomization: avatarCustomizationSchema.nullable().parse(entry.avatarCustomization ?? null),
        rank: offset + i + 1,
        ...computeTrend(trendWins, trendTotal),
      };
    });

    res.json({ entries: ranked });
  },

  async getUserRank(req: Request, res: Response): Promise<void> {
    const userId = req.user!.id;
    const scope = (req.query.scope as string) || 'global';

    const profile = await rankedService.ensureProfile(userId);

    // Don't return rank for users who haven't completed placement
    if (profile.placement_status !== 'placed') {
      res.json(null);
      return;
    }

    const user = await usersRepo.getById(userId);

    const country = scope === 'country' ? (user?.country ?? undefined) : undefined;
    const rankInfo = await rankedService.getUserRank(userId, country);

    if (!rankInfo) {
      res.json(null);
      return;
    }

    res.json({
      userId,
      username: user?.nickname ?? 'Player',
      avatarUrl: user?.avatar_url ?? null,
      avatarCustomization: avatarCustomizationSchema.nullable().parse(user?.avatar_customization ?? null),
      country: user?.country ?? null,
      rp: profile.rp,
      tier: profile.tier,
      rank: rankInfo.rank,
      total: rankInfo.total,
      ...computeTrend(rankInfo.trendWins, rankInfo.trendTotal),
    });
  },
};
