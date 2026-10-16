import type { Request, Response } from 'express';
import { usersRepo } from '../users/users.repo.js';
import { parseStoredAvatarCustomization } from '../users/avatar-customization.js';
import { footballGridLeaderboardService } from './football-grid-leaderboard.service.js';
import type {
  FootballGridLeaderboardQuery,
  FootballGridUserRankQuery,
} from './football-grid-leaderboard.schemas.js';
import { normalizeSupportedCountryCode } from '../../core/country.js';
import { resolveBoardFilter } from '../leaderboards/board-filter.js';
import { nextTargetOf } from '../leaderboards/board-response.js';

export const footballGridLeaderboardController = {
  async getLeaderboard(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as FootballGridLeaderboardQuery;
    const { limit, offset } = query;
    const filter = await resolveBoardFilter(req, query);
    if (!filter) {
      res.json({ entries: [] });
      return;
    }

    const entries = await footballGridLeaderboardService.getLeaderboard(limit, offset, filter);
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
    const query = req.validated.query as FootballGridUserRankQuery;
    const user = await usersRepo.getById(userId);
    const filter = await resolveBoardFilter(req, query);
    if (!filter) {
      res.json(null);
      return;
    }

    const rankInfo = await footballGridLeaderboardService.getUserRank(userId, filter);
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
      ticTacToePoints: rankInfo.ticTacToePoints,
      tier: rankInfo.tier ?? null,
      rank: rankInfo.rank,
      total: rankInfo.total,
      nextTarget: nextTargetOf(rankInfo.rank, rankInfo.ticTacToePoints, rankInfo.nextAbove),
    });
  },
};
