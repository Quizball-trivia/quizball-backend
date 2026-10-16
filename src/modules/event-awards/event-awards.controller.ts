import type { Request, Response } from 'express';
import { z } from 'zod';
import { eventAwardsRepo, type EventAwardRow } from './event-awards.repo.js';
import { usersService } from '../users/users.service.js';
import type { UserIdParam } from '../users/users.schemas.js';

export const awardIdParamSchema = z.object({
  awardId: z.string().uuid(),
});
export type AwardIdParam = z.infer<typeof awardIdParamSchema>;

// Season country/club trophies (lb-…). Older web builds and the mobile app
// render any slug they do not know as a World Cup medal, so they only get
// these when they ask for them.
const BOARD_TROPHY_SLUG = /^lb-s\d+-(country|club)-/;

function visibleTo(req: Request, rows: EventAwardRow[]): EventAwardRow[] {
  return req.query.boardTrophies === '1' ? rows : rows.filter((row) => !BOARD_TROPHY_SLUG.test(row.event_slug));
}

function toPublicAward(row: EventAwardRow) {
  return {
    id: row.id,
    eventSlug: row.event_slug,
    place: row.place,
    awardedAt: row.awarded_at,
  };
}

function toOwnResponse(rows: EventAwardRow[]) {
  return {
    awards: rows.map((row) => ({ ...toPublicAward(row), seen: row.seen_at !== null })),
  };
}

function toPublicResponse(rows: EventAwardRow[]) {
  return { awards: rows.map(toPublicAward) };
}

export const eventAwardsController = {
  async getMyAwards(req: Request, res: Response): Promise<void> {
    const rows = await eventAwardsRepo.listForUser(req.user!.id);
    res.json(toOwnResponse(visibleTo(req, rows)));
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
    res.json(toPublicResponse(visibleTo(req, rows)));
  },
};
