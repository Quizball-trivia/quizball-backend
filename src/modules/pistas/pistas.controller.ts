import type { Request, Response } from 'express';
import { pistasService } from './pistas.service.js';
import { guestSessionRequired } from './pistas.errors.js';
import type { Player } from './pistas.types.js';
import type { DayQuery, GuessRequest, MoveRequest, ReviewQuery, StartRequest } from './pistas.schemas.js';

/** Set by the routes' identity middleware: a member session, else a guest session. */
function playerOf(req: Request): Player {
  if (req.user) return { kind: 'member', userId: req.user.id };
  if (req.guest) return { kind: 'guest', guestId: req.guest.id };
  throw guestSessionRequired();
}

export const pistasController = {
  async start(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as StartRequest;
    res.json(await pistasService.start(body.day, playerOf(req), body.contentVersion));
  },
  async reveal(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as MoveRequest;
    res.json(await pistasService.reveal(playerOf(req), body.runId, body.version));
  },
  async guess(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as GuessRequest;
    res.json(await pistasService.guess(playerOf(req), body.runId, body.version, body.guess));
  },
  async giveUp(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as MoveRequest;
    res.json(await pistasService.giveUp(playerOf(req), body.runId, body.version));
  },
  async next(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as MoveRequest;
    res.json(await pistasService.next(playerOf(req), body.runId, body.version));
  },
  async current(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await pistasService.current(playerOf(req), query.day));
  },
  async boards(_req: Request, res: Response): Promise<void> {
    const index = await pistasService.boards();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(index);
  },
  /** Only closed days are served, and a closed day only changes through a (rare) correction. */
  async review(req: Request, res: Response): Promise<void> {
    const { day } = req.validated.query as ReviewQuery;
    const review = await pistasService.review(day);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(review);
  },
  /** Members see their own row in `me`; guests are never on the board. */
  async leaderboard(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    const board = await pistasService.leaderboard(query.day, req.user?.id ?? null);
    const anonymous = !req.headers.authorization && !req.cookies?.qb_access_token;
    res.setHeader('Cache-Control', anonymous ? 'public, max-age=15' : 'private, no-store');
    res.json(board);
  },
};
