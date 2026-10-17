import type { Request, Response } from 'express';
import { auctionLeaderboardService } from './auction-leaderboard.service.js';
import { usersRepo } from '../users/users.repo.js';
import { parseStoredAvatarCustomization } from '../users/avatar-customization.js';
import type {
  AuctionLeaderboardQuery,
  AuctionUserRankQuery,
} from './auction-leaderboard.schemas.js';
import { normalizeSupportedCountryCode } from '../../core/country.js';
import { resolveBoardFilter } from '../leaderboards/board-filter.js';
import { nextTargetOf } from '../leaderboards/board-response.js';

export const auctionLeaderboardController = {
  async getLeaderboard(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as AuctionLeaderboardQuery;
    const { limit, offset } = query;

    const filter = await resolveBoardFilter(req, query);
    if (!filter) {
      res.json({ entries: [] });
      return;
    }

    const entries = await auctionLeaderboardService.getLeaderboard(limit, offset, filter);

    res.json({
      entries: entries.map((entry, i) => ({
        ...entry,
        avatarCustomization: parseStoredAvatarCustomization(entry.avatarCustomization),
        rank: offset + i + 1,
      })),
    });
  },

  async getUserRank(req: Request, res: Response): Promise<void> {
    const userId = req.user!.id;
    const query = req.validated.query as AuctionUserRankQuery;

    const user = await usersRepo.getById(userId);
    const filter = await resolveBoardFilter(req, query);
    if (!filter) {
      res.json(null);
      return;
    }

    // null = not on the board yet (no AP earned, or not in this country/club),
    // which the client renders as "unranked" rather than as a position.
    const rankInfo = await auctionLeaderboardService.getUserRank(userId, filter);
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
      auctionPoints: rankInfo.auctionPoints,
      tier: rankInfo.tier ?? null,
      rank: rankInfo.rank,
      total: rankInfo.total,
      nextTarget: nextTargetOf(rankInfo.rank, rankInfo.auctionPoints, rankInfo.nextAbove),
    });
  },
};
