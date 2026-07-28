import type { Request, Response } from 'express';
import { auctionPipelineService } from './auction-pipeline.service.js';
import type {
  AuctionPipelinePromptKeyParam,
  AuctionPipelinePromptUpdate,
  AuctionPipelineRequeueRequest,
} from './auction-pipeline.schemas.js';

export const auctionPipelineController = {
  async getStats(_req: Request, res: Response): Promise<void> {
    const result = await auctionPipelineService.getStats();
    res.json(result);
  },

  async listWorkers(_req: Request, res: Response): Promise<void> {
    const result = await auctionPipelineService.listWorkers();
    res.json(result);
  },

  async listPrompts(_req: Request, res: Response): Promise<void> {
    const items = await auctionPipelineService.listPrompts();
    res.json({ items });
  },

  async savePrompt(req: Request, res: Response): Promise<void> {
    const { key } = req.validated.params as AuctionPipelinePromptKeyParam;
    const { text } = req.validated.body as AuctionPipelinePromptUpdate;
    const result = await auctionPipelineService.savePrompt(key, text, req.user!.id);
    res.json(result);
  },

  async requeueTasks(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as AuctionPipelineRequeueRequest;
    const result = await auctionPipelineService.requeueTasks(body, req.user!.id);
    res.json(result);
  },
};
