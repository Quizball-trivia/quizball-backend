import type { Request, Response } from 'express';
import { statsService } from './stats.service.js';
import type { HeadToHeadQuery } from './stats.schemas.js';

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
};
