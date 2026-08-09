import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthenticationError } from '../../core/errors.js';
import { weekendLeagueService } from './weekend-league.service.js';

function requireUserId(req: Request): string {
  const userId = req.user?.id;
  if (!userId) throw new AuthenticationError('Authentication required');
  return userId;
}

const testTargetSchema = z.object({ tournament_id: z.string().uuid().optional() }).passthrough();

export const weekendLeagueController = {
  async current(req: Request, res: Response): Promise<void> {
    res.json(await weekendLeagueService.current(requireUserId(req)));
  },

  async standings(req: Request, res: Response): Promise<void> {
    requireUserId(req);
    res.json(await weekendLeagueService.standings());
  },

  async qp(req: Request, res: Response): Promise<void> {
    res.json(await weekendLeagueService.qp(requireUserId(req)));
  },

  async enter(req: Request, res: Response): Promise<void> {
    // Optional body.tournament_id targets an is_test event only (harness
    // affordance — see service.resolveTarget); ignored otherwise.
    const tournamentId = testTargetSchema.parse(req.body ?? {}).tournament_id;
    res.json(await weekendLeagueService.enter(requireUserId(req), tournamentId));
  },

  async checkin(req: Request, res: Response): Promise<void> {
    const tournamentId = testTargetSchema.parse(req.body ?? {}).tournament_id;
    res.json(await weekendLeagueService.checkin(requireUserId(req), tournamentId));
  },
};
