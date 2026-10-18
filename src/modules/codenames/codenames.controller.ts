import type { Request, Response } from 'express';
import { guestSessionRequired } from '../daily/daily.errors.js';
import { codenamesService } from './codenames.service.js';
import type { Player } from './codenames.types.js';
import type { DayQuery, FlipRequest, ReviewQuery, StartRequest, StopRequest } from './codenames.schemas.js';

function playerOf(req: Request): Player {
  if (req.user) return { kind: 'member', userId: req.user.id };
  if (req.guest) return { kind: 'guest', guestId: req.guest.id };
  throw guestSessionRequired();
}

export const codenamesController = {
  async start(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as StartRequest;
    res.json(await codenamesService.start(body.day, playerOf(req), body.contentVersion));
  },
  async flip(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as FlipRequest;
    res.json(await codenamesService.flip(playerOf(req), body.runId, body.version, body.card));
  },
  async stop(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as StopRequest;
    res.json(await codenamesService.stop(playerOf(req), body.runId, body.version));
  },
  async current(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await codenamesService.current(playerOf(req), query.day));
  },
  async boards(_req: Request, res: Response): Promise<void> {
    const index = await codenamesService.boards();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(index);
  },
  async review(req: Request, res: Response): Promise<void> {
    const { day } = req.validated.query as ReviewQuery;
    const review = await codenamesService.review(day);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(review);
  },
  async leaderboard(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    const board = await codenamesService.leaderboard(query.day, req.user?.id ?? null);
    const anonymous = !req.headers.authorization && !req.cookies?.qb_access_token;
    res.setHeader('Cache-Control', anonymous ? 'public, max-age=15' : 'private, no-store');
    res.json(board);
  },
};
