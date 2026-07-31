import type { Request, Response } from 'express';
import { AuthenticationError } from '../../core/errors.js';
import { weekendLeagueService } from './weekend-league.service.js';

function requireUserId(req: Request): string {
  const userId = req.user?.id;
  if (!userId) throw new AuthenticationError('Authentication required');
  return userId;
}

export const weekendLeagueController = {
  async current(req: Request, res: Response): Promise<void> {
    res.json(await weekendLeagueService.current(requireUserId(req)));
  },

  async qp(req: Request, res: Response): Promise<void> {
    res.json(await weekendLeagueService.qp(requireUserId(req)));
  },

  async enter(req: Request, res: Response): Promise<void> {
    res.json(await weekendLeagueService.enter(requireUserId(req)));
  },

  async checkin(req: Request, res: Response): Promise<void> {
    res.json(await weekendLeagueService.checkin(requireUserId(req)));
  },
};
