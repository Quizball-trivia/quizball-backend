import type { Request, Response } from 'express';
import { usersRepo } from '../users/users.repo.js';
import { parseStoredAvatarCustomization } from '../users/avatar-customization.js';
import { footballGridLeaderboardService } from './football-grid-leaderboard.service.js';
import type {
  FootballGridLeaderboardQuery,
  FootballGridUserRankQuery,
} from './football-grid-leaderboard.schemas.js';

export const footballGridLeaderboardController = {
  async getLeaderboard(req: Request, res: Response): Promise<void> {
    const { limit, offset, scope } = req.validated.query as FootballGridLeaderboardQuery;
    let country: string | undefined;
    if (scope === 'country') {
      const user = await usersRepo.getById(req.user!.id);
      country = user?.country || undefined;
      if (!country) {
        res.json({ entries: [] });
        return;
      }
    }

    const entries = await footballGridLeaderboardService.getLeaderboard(limit, offset, country);
    res.json({
      entries: entries.map((entry, index) => ({
        ...entry,
        avatarCustomization: parseStoredAvatarCustomization(entry.avatarCustomization),
        rank: offset + index + 1,
      })),
    });
  },

  async getUserRank(req: Request, res: Response): Promise<void> {
    const userId = req.user!.id;
    const { scope } = req.validated.query as FootballGridUserRankQuery;
    const user = await usersRepo.getById(userId);
    const country = scope === 'country'
      ? user?.country || undefined
      : undefined;
    if (scope === 'country' && !country) {
      res.json(null);
      return;
    }

    const rankInfo = await footballGridLeaderboardService.getUserRank(userId, country);
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
      ticTacToePoints: rankInfo.ticTacToePoints,
      tier: rankInfo.tier ?? null,
      rank: rankInfo.rank,
      total: rankInfo.total,
    });
  },
};
