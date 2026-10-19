import type { Request, Response } from 'express';
import { playerOf, type DayQuery, type MoveRequest, type ReviewQuery, type StartRequest } from '../wordgame-daily/wordgame-daily.shared.js';
import type { JokerRequest, PickRequest } from './dato-falso.schemas.js';
import { datoFalsoService } from './dato-falso.service.js';

export const datoFalsoController = {
  async start(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as StartRequest;
    res.json(await datoFalsoService.start(body.day, playerOf(req), body.contentVersion));
  },
  async next(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as MoveRequest;
    res.json(await datoFalsoService.next(playerOf(req), body.runId, body.version));
  },
  async joker(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as JokerRequest;
    res.json(await datoFalsoService.joker(playerOf(req), body.runId, body.version, body.kind));
  },
  async pick(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as PickRequest;
    res.json(await datoFalsoService.pick(playerOf(req), body.runId, body.version, body.option));
  },
  async current(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await datoFalsoService.current(playerOf(req), query.day));
  },
  async boards(_req: Request, res: Response): Promise<void> {
    const index = await datoFalsoService.boards();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(index);
  },
  /** Only closed days are served, and a closed day only changes through a (rare) correction. */
  async review(req: Request, res: Response): Promise<void> {
    const { day } = req.validated.query as ReviewQuery;
    const review = await datoFalsoService.review(day);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(review);
  },
  /** Members see their own row in `me`; guests are never on the board. */
  async leaderboard(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    const board = await datoFalsoService.leaderboard(query.day, req.user?.id ?? null);
    const anonymous = !req.headers.authorization && !req.cookies?.qb_access_token;
    res.setHeader('Cache-Control', anonymous ? 'public, max-age=15' : 'private, no-store');
    res.json(board);
  },
};
