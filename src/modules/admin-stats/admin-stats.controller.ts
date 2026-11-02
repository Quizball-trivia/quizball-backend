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

import { adminPersonsService } from './admin-stats.service.js';
import type { PersonsQuery, PersonParams } from './admin-stats.schemas.js';

export const adminPersonsController = {
  /** GET /api/v1/admin/stats/persons — browse registered users or playing guest journeys. */
  async list(req: Request, res: Response): Promise<void> {
    res.json(await adminPersonsService.list(req.validated.query as PersonsQuery));
  },

  /** GET /api/v1/admin/stats/persons/:kind/:id/activity — one person's DB-truth journey. */
  async activity(req: Request, res: Response): Promise<void> {
    res.json(await adminPersonsService.activity(req.validated.params as PersonParams));
  },
};
