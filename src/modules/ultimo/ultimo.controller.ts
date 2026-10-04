import type { Request, Response } from 'express';
import { boardsMaxAge } from '../daily/daily.calendar.js';
import { ultimoService } from './ultimo.service.js';
import { guestSessionRequired } from './ultimo.errors.js';
import type { Player } from './ultimo.types.js';
import type { AnswerRequest, DayQuery, MoveRequest, ReviewQuery, StartRequest } from './ultimo.schemas.js';

/** Set by the routes' identity middleware: a member session, else a guest session. */
function playerOf(req: Request): Player {
  if (req.user) return { kind: 'member', userId: req.user.id };
  if (req.guest) return { kind: 'guest', guestId: req.guest.id };
  throw guestSessionRequired();
}

export const ultimoController = {
  async start(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as StartRequest;
    res.json(await ultimoService.start(body.day, playerOf(req), body.contentVersion));
  },
  async begin(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as MoveRequest;
    res.json(await ultimoService.begin(playerOf(req), body.runId, body.version));
  },
  async answer(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as AnswerRequest;
    res.json(await ultimoService.answer(playerOf(req), body.runId, body.version, body.answer));
  },
  async next(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as MoveRequest;
    res.json(await ultimoService.next(playerOf(req), body.runId, body.version));
  },
  async current(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await ultimoService.current(playerOf(req), query.day));
  },
  async boards(_req: Request, res: Response): Promise<void> {
    // Read before the index is built: an index from just before midnight must not get a lifetime computed after it.
    const maxAge = boardsMaxAge();
    const index = await ultimoService.boards();
    res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
    res.json(index);
  },
  /** Only closed days are served, and a closed day only changes through a (rare) correction. */
  async review(req: Request, res: Response): Promise<void> {
    const { day } = req.validated.query as ReviewQuery;
    const review = await ultimoService.review(day);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(review);
  },
  /** Members see their own row in `me`; guests are never on the board. */
  async leaderboard(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    // The default board turns over at midnight: a shared copy must not answer for the next day.
    const maxAge = boardsMaxAge(new Date(), 15);
    const board = await ultimoService.leaderboard(query.day, req.user?.id ?? null);
    const anonymous = !req.headers.authorization && !req.cookies?.qb_access_token;
    res.setHeader('Cache-Control', anonymous ? `public, max-age=${maxAge}` : 'private, no-store');
    res.json(board);
  },
};
