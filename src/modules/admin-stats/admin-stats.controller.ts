import type { Request, Response } from 'express';
import { adminStatsService } from './admin-stats.service.js';

export const adminStatsController = {
  async getOverview(_req: Request, res: Response): Promise<void> {
    const overview = await adminStatsService.getOverview();
    res.json(overview);
  },
};
