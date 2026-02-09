import type { Request, Response } from 'express';
import { statsService } from './stats.service.js';
import type { HeadToHeadQuery, RecentMatchesQuery } from './stats.schemas.js';

/**
 * Stats controller.
 * Translates HTTP <-> Service calls. NO business logic.
 * Controllers read ONLY req.validated.* (never req.body directly).
 */
export const statsController = {
  /**
   * GET /api/v1/stats/head-to-head
   * Get head-to-head summary for two users.
   */
  async headToHead(req: Request, res: Response): Promise<void> {
    const { userA, userB } = req.validated.query as HeadToHeadQuery;
    const summary = await statsService.getHeadToHead(userA, userB);
    res.json(summary);
  },

  /**
   * GET /api/v1/stats/recent-matches
   * Get recent completed/abandoned matches for the authenticated user.
   */
  async recentMatches(req: Request, res: Response): Promise<void> {
    const { limit } = req.validated.query as RecentMatchesQuery;
    const items = await statsService.getRecentMatchesForUser(req.user!.id, limit);
    res.json({ items });
  },

  /**
   * GET /api/v1/stats/summary
   * Get aggregated stats for authenticated user (overall + ranked + friendly).
   */
  async summary(req: Request, res: Response): Promise<void> {
    const summary = await statsService.getUserStatsSummary(req.user!.id);
    res.json(summary);
  },
};
