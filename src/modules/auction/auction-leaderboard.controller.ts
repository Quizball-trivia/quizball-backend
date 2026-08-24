import type { Request, Response } from 'express';
import { auctionLeaderboardService } from './auction-leaderboard.service.js';
import { usersRepo } from '../users/users.repo.js';
import { parseStoredAvatarCustomization } from '../users/avatar-customization.js';
import type {
  AuctionLeaderboardQuery,
  AuctionUserRankQuery,
} from './auction-leaderboard.schemas.js';

export const auctionLeaderboardController = {
  async getLeaderboard(req: Request, res: Response): Promise<void> {
    const { limit, offset, scope } = req.validated.query as AuctionLeaderboardQuery;

    let country: string | undefined;
    if (scope === 'country') {
      const user = await usersRepo.getById(req.user!.id);
      country = user?.country ?? undefined;
    }

    const entries = await auctionLeaderboardService.getLeaderboard(limit, offset, country);

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
    const { scope } = req.validated.query as AuctionUserRankQuery;

    const user = await usersRepo.getById(userId);
    const country = scope === 'country' ? (user?.country ?? undefined) : undefined;

    // null = not on the board yet (no AP earned), which the client renders as
    // "unranked" rather than as a position.
    const rankInfo = await auctionLeaderboardService.getUserRank(userId, country);
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
      auctionPoints: rankInfo.auctionPoints,
      rank: rankInfo.rank,
      total: rankInfo.total,
    });
  },
};
