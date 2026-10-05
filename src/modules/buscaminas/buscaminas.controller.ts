import type { Request, Response } from 'express';
import { boardsMaxAge } from './buscaminas.days.js';
import { buscaminasService } from './buscaminas.service.js';
import { guestSessionRequired } from './buscaminas.errors.js';
import type { Player } from './buscaminas.types.js';
import type { BoardParams, DayQuery, MoveRequest, StartRequest, TapRequest } from './buscaminas.schemas.js';

/** Set by the routes' identity middleware: a member session, else a guest session. */
function playerOf(req: Request): Player {
  if (req.user) return { kind: 'member', userId: req.user.id };
  if (req.guest) return { kind: 'guest', guestId: req.guest.id };
  throw guestSessionRequired();
}

export const buscaminasController = {
  async start(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as StartRequest;
    res.json(await buscaminasService.start(body.day, playerOf(req), body.contentVersion));
  },
  async tap(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as TapRequest;
    res.json(await buscaminasService.tap(playerOf(req), body.runId, body.version, body.cardId));
  },
  async bank(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as MoveRequest;
    res.json(await buscaminasService.bank(playerOf(req), body.runId, body.version));
  },
  async next(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as MoveRequest;
    res.json(await buscaminasService.next(playerOf(req), body.runId, body.version));
  },
  async current(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await buscaminasService.current(playerOf(req), query.day));
  },
  /** A finished day is cached for a day; the live one only for minutes, so it can be corrected the same day. */
  async board(req: Request, res: Response): Promise<void> {
    const { day } = req.validated.params as BoardParams;
    const { board, live } = await buscaminasService.board(day);
    res.setHeader('Cache-Control', live ? 'public, max-age=300' : 'public, max-age=86400');
    res.json(board);
  },
  async boards(_req: Request, res: Response): Promise<void> {
    // Read before the index is built: an index from just before midnight must not get a lifetime computed after it.
    const maxAge = boardsMaxAge();
    const index = await buscaminasService.boards();
    res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
    res.json(index);
  },
  /** Members see their own row in `me`; guests are never on the board. */
  async leaderboard(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    // The default board turns over at midnight: a shared copy must not answer for the next day.
    const maxAge = boardsMaxAge(new Date(), 15);
    const board = await buscaminasService.leaderboard(query.day, req.user?.id ?? null);
    const anonymous = !req.headers.authorization && !req.cookies?.qb_access_token;
    res.setHeader('Cache-Control', anonymous ? `public, max-age=${maxAge}` : 'private, no-store');
    res.json(board);
  },
};
