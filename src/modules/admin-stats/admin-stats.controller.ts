import type { Request, Response } from 'express';
import { adminStatsService } from './admin-stats.service.js';

export const adminStatsController = {
  /**
   * GET /api/v1/admin/stats/analytics-overview
   * Real-numbers product analytics from the production database (admin only).
   */
  async analyticsOverview(_req: Request, res: Response): Promise<void> {
    res.json(await adminStatsService.analyticsOverview());
  },
};
