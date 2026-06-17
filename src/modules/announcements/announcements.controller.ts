import type { Request, Response } from 'express';
import { announcementsService } from './announcements.service.js';
import type {
  AnnouncementIdParam,
  CreateAnnouncementBody,
  UpdateAnnouncementBody,
} from './announcements.schemas.js';

/**
 * Announcements controller. Translates HTTP ↔ service. No business logic.
 * Public read is the active feed; admin routes (guarded upstream) manage CRUD.
 */
export const announcementsController = {
  // Public — active announcements for the player News list.
  async listActive(_req: Request, res: Response): Promise<void> {
    const result = await announcementsService.listActive();
    res.json(result);
  },

  // Admin — full list including inactive.
  async listAll(_req: Request, res: Response): Promise<void> {
    const result = await announcementsService.listAll();
    res.json(result);
  },

  async create(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as CreateAnnouncementBody;
    const announcement = await announcementsService.create(body, req.user?.id ?? null);
    res.status(201).json(announcement);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { announcementId } = req.validated.params as AnnouncementIdParam;
    const body = req.validated.body as UpdateAnnouncementBody;
    const announcement = await announcementsService.update(announcementId, body);
    res.json(announcement);
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { announcementId } = req.validated.params as AnnouncementIdParam;
    await announcementsService.remove(announcementId);
    res.status(204).send();
  },
};
