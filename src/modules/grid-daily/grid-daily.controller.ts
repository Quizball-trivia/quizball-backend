import type { Request, Response } from 'express';
import { guestSessionRequired } from '../daily/daily.errors.js';
import { gridDailyService } from './grid-daily.service.js';
import type { DayQuery, GuessRequest, MoveRequest, ReviewQuery, StartRequest } from './grid-daily.schemas.js';
import type { Player } from './grid-daily.types.js';

/** Set by the routes' identity middleware: a member session, else a guest session. */
function playerOf(req: Request): Player {
  if (req.user) return { kind: 'member', userId: req.user.id };
  if (req.guest) return { kind: 'guest', guestId: req.guest.id };
  throw guestSessionRequired();
}

export const gridDailyController = {
  async start(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as StartRequest;
    res.json(await gridDailyService.start(body.day, playerOf(req), body.contentVersion));
  },
  async guess(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as GuessRequest;
    res.json(await gridDailyService.guess(playerOf(req), body));
  },
  async finish(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as MoveRequest;
    res.json(await gridDailyService.finish(playerOf(req), body.runId, body.version));
  },
  async current(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await gridDailyService.current(playerOf(req), query.day));
  },
  async boards(_req: Request, res: Response): Promise<void> {
    const index = await gridDailyService.boards();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(index);
  },
  /** Only closed days are served. */
  async review(req: Request, res: Response): Promise<void> {
    const { day } = req.validated.query as ReviewQuery;
    const review = await gridDailyService.review(day);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(review);
  },
  /** Members see their own row in `me`; guests are never on the board. */
  async leaderboard(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    const board = await gridDailyService.leaderboard(query.day, req.user?.id ?? null);
    const anonymous = !req.headers.authorization && !req.cookies?.qb_access_token;
    res.setHeader('Cache-Control', anonymous ? 'public, max-age=15' : 'private, no-store');
    res.json(board);
  },
};
