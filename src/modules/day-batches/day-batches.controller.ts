import type { Request, Response } from 'express';
import { dayBatchesService } from './day-batches.service.js';
import type { DailyGameParam, DayBatchHoldBody, DayBatchIdParam, ListDayBatchesQuery, RejectDayBatchBody, SpawnDayBatchBody } from './day-batches.schemas.js';

// Admin controller for the CMS "Daily games" page: batches of days the agents pipeline built, awaiting approval.
export const dayBatchesController = {
  async list(req: Request, res: Response): Promise<void> {
    res.json(await dayBatchesService.list(req.validated.query as ListDayBatchesQuery));
  },

  async buffers(_req: Request, res: Response): Promise<void> {
    res.json(await dayBatchesService.buffers());
  },

  async get(req: Request, res: Response): Promise<void> {
    const { batchId } = req.validated.params as DayBatchIdParam;
    res.json(await dayBatchesService.get(batchId));
  },

  async approve(req: Request, res: Response): Promise<void> {
    const { batchId } = req.validated.params as DayBatchIdParam;
    res.json(await dayBatchesService.approve(batchId, req.user?.id ?? null));
  },

  async reject(req: Request, res: Response): Promise<void> {
    const { batchId } = req.validated.params as DayBatchIdParam;
    const { reason } = req.validated.body as RejectDayBatchBody;
    res.json(await dayBatchesService.reject(batchId, req.user?.id ?? null, reason));
  },

  async spawn(req: Request, res: Response): Promise<void> {
    const { game, days } = req.validated.body as SpawnDayBatchBody;
    res.status(201).json(await dayBatchesService.spawn(game, days, req.user?.id ?? null));
  },

  async setHold(req: Request, res: Response): Promise<void> {
    const { game } = req.validated.params as DailyGameParam;
    const { hold } = req.validated.body as DayBatchHoldBody;
    await dayBatchesService.setHold(game, hold, req.user?.id ?? null);
    res.status(204).send();
  },
};
