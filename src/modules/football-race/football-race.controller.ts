import type { Request, Response } from 'express';
import { guestSessionRequired } from '../daily/daily.errors.js';
import { footballRaceService } from './football-race.service.js';
import type { Player } from './football-race.types.js';
import type { DayQuery, PickRequest, ReviewQuery, StartRequest } from './football-race.schemas.js';

function playerOf(req: Request): Player {
  if (req.user) return { kind: 'member', userId: req.user.id };
  if (req.guest) return { kind: 'guest', guestId: req.guest.id };
  throw guestSessionRequired();
}

export const footballRaceController = {
  async start(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as StartRequest;
    res.json(await footballRaceService.start(body.day, playerOf(req), body.contentVersion));
  },
  async pick(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as PickRequest;
    res.json(await footballRaceService.pick(playerOf(req), body.runId, body.version, body.stat));
  },
  async current(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await footballRaceService.current(playerOf(req), query.day));
  },
  async boards(_req: Request, res: Response): Promise<void> {
    const index = await footballRaceService.boards();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(index);
  },
  async review(req: Request, res: Response): Promise<void> {
    const { day } = req.validated.query as ReviewQuery;
    const review = await footballRaceService.review(day);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(review);
  },
  async leaderboard(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    const board = await footballRaceService.leaderboard(query.day, req.user?.id ?? null);
    const anonymous = !req.headers.authorization && !req.cookies?.qb_access_token;
    res.setHeader('Cache-Control', anonymous ? 'public, max-age=15' : 'private, no-store');
    res.json(board);
  },
};
