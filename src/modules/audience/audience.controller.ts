import type { Request, Response } from 'express';
import { audienceService } from './audience.service.js';
import type { AudienceQuery } from './audience.schemas.js';

export const audienceController = {
  /** GET /api/v1/admin/stats/audience?period=today|yesterday|7d|30d — who played, from where, which games. */
  async get(req: Request, res: Response): Promise<void> {
    const { period } = req.validated.query as AudienceQuery;
    res.json(await audienceService.get(period));
  },
};
