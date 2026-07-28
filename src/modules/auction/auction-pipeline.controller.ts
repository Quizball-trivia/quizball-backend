import type { Request, Response } from 'express';
import { auctionPipelineService } from './auction-pipeline.service.js';

export const auctionPipelineController = {
  async getStats(_req: Request, res: Response): Promise<void> {
    const result = await auctionPipelineService.getStats();
    res.json(result);
  },
};
