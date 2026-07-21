import type { Request, Response } from 'express';
import { z } from 'zod';
import { eventAwardsRepo, type EventAwardRow } from './event-awards.repo.js';
import { usersService } from '../users/users.service.js';
import type { UserIdParam } from '../users/users.schemas.js';

export const awardIdParamSchema = z.object({
  awardId: z.string().uuid(),
});
export type AwardIdParam = z.infer<typeof awardIdParamSchema>;

function toResponse(rows: EventAwardRow[]) {
  return {
    awards: rows.map((row) => ({
      id: row.id,
      eventSlug: row.event_slug,
      place: row.place,
      awardedAt: row.awarded_at,
      seen: row.seen_at !== null,
    })),
  };
}

export const eventAwardsController = {
  async getMyAwards(req: Request, res: Response): Promise<void> {
    const rows = await eventAwardsRepo.listForUser(req.user!.id);
    res.json(toResponse(rows));
  },

  async markSeen(req: Request, res: Response): Promise<void> {
    const { awardId } = req.validated.params as AwardIdParam;
    const updated = await eventAwardsRepo.markSeen(req.user!.id, awardId);
    res.json({ acknowledged: updated });
  },

  async getUserAwards(req: Request, res: Response): Promise<void> {
    const { userId } = req.validated.params as UserIdParam;
    await usersService.assertPublicUserVisible(userId);
    const rows = await eventAwardsRepo.listForUser(userId);
    res.json(toResponse(rows));
  },
};
