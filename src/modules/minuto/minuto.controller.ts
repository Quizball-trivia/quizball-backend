import type { Request, Response } from 'express';
import { minutoService } from './minuto.service.js';
import { guestSessionRequired } from './minuto.errors.js';
import type { Player } from './minuto.types.js';
import type { DayQuery, GuessRequest, MoveRequest, ReviewQuery, StartRequest } from './minuto.schemas.js';

/** Set by the routes' identity middleware: a member session, else a guest session. */
function playerOf(req: Request): Player {
  if (req.user) return { kind: 'member', userId: req.user.id };
  if (req.guest) return { kind: 'guest', guestId: req.guest.id };
  throw guestSessionRequired();
}

export const minutoController = {
  async start(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as StartRequest;
    res.json(await minutoService.start(body.day, playerOf(req), body.contentVersion));
  },
  async guess(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as GuessRequest;
    res.json(await minutoService.guess(playerOf(req), body.runId, body.version, body.minute));
  },
  async next(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as MoveRequest;
    res.json(await minutoService.next(playerOf(req), body.runId, body.version));
  },
  async current(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await minutoService.current(playerOf(req), query.day));
  },
  async boards(_req: Request, res: Response): Promise<void> {
    const index = await minutoService.boards();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(index);
  },
  /** Only closed days are served, and a closed day only changes through a (rare) correction. */
  async review(req: Request, res: Response): Promise<void> {
    const { day } = req.validated.query as ReviewQuery;
    const review = await minutoService.review(day);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(review);
  },
  /** Members see their own row in `me`; guests are never on the board. */
  async leaderboard(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    const board = await minutoService.leaderboard(query.day, req.user?.id ?? null);
    const anonymous = !req.headers.authorization && !req.cookies?.qb_access_token;
    res.setHeader('Cache-Control', anonymous ? 'public, max-age=15' : 'private, no-store');
    res.json(board);
  },
};
