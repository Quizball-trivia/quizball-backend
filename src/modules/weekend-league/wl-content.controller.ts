/** CMS surface for WL content import — bearer admin (see admin-wl.routes). */

import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  wlContentBatch,
  wlContentBatches,
  wlContentCheck,
  wlContentImport,
  wlContentNextEvent,
  wlContentReseed,
  wlContentRunway,
  wlContentScheduleBatch,
  wlContentUndoBatch,
} from './wl-content.service.js';
import { wlContentCheckSchema, wlContentImportSchema, wlContentScheduleSchema, wlLineupPreviewSchema, wlLineupSaveSchema } from './wl-content.schemas.js';
import { wlLineupEvents, wlLineupPreview, wlLineupSave } from './wl-lineup.service.js';

const idParamSchema = z.object({ id: z.string().uuid() });

function actorOf(req: Request): { id?: string; email?: string } {
  const user = (req as Request & { user?: { id?: string; email?: string } }).user;
  return { id: user?.id, email: user?.email };
}

export const wlContentController = {
  async check(req: Request, res: Response): Promise<void> {
    const body = wlContentCheckSchema.parse(req.body);
    res.json(await wlContentCheck(body.questions));
  },

  async import(req: Request, res: Response): Promise<void> {
    const body = wlContentImportSchema.parse(req.body);
    res.status(202).json(await wlContentImport(body, actorOf(req)));
  },

  async batches(_req: Request, res: Response): Promise<void> {
    res.json({ batches: await wlContentBatches() });
  },

  async batch(req: Request, res: Response): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    res.json(await wlContentBatch(id));
  },

  async undoBatch(req: Request, res: Response): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const actor = actorOf(req);
    res.json(await wlContentUndoBatch(id, `admin:${actor.email ?? actor.id ?? 'unknown'}`));
  },

  async runway(_req: Request, res: Response): Promise<void> {
    res.json(await wlContentRunway());
  },

  async nextEvent(req: Request, res: Response): Promise<void> {
    const { tournament_id } = z.object({ tournament_id: z.string().uuid().optional() }).parse(req.query);
    res.json(await wlContentNextEvent(tournament_id));
  },

  async lineupEvents(_req: Request, res: Response): Promise<void> {
    res.json({ events: await wlLineupEvents() });
  },

  async lineupPreview(req: Request, res: Response): Promise<void> {
    const body = wlLineupPreviewSchema.parse(req.body);
    res.json(await wlLineupPreview(body, actorOf(req)));
  },

  async lineupSave(req: Request, res: Response): Promise<void> {
    const { preview_id } = wlLineupSaveSchema.parse(req.body);
    res.status(202).json(await wlLineupSave(preview_id, actorOf(req)));
  },

  async scheduleBatch(req: Request, res: Response): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const actor = actorOf(req);
    const { tournament_id } = wlContentScheduleSchema.parse(req.body ?? {});
    res.json(await wlContentScheduleBatch(id, `admin:${actor.email ?? actor.id ?? 'unknown'}`, tournament_id));
  },

  async reseed(req: Request, res: Response): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const actor = actorOf(req);
    res.json(await wlContentReseed(id, `admin:${actor.email ?? actor.id ?? 'unknown'}`));
  },
};
