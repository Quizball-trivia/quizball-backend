import type { Request, Response } from 'express';
import { playerOf, type DayQuery, type MoveRequest, type ReviewQuery, type StartRequest } from '../wordgame-daily/wordgame-daily.shared.js';
import type { GuessRequest } from './conexiones.schemas.js';
import { conexionesService } from './conexiones.service.js';

export const conexionesController = {
  async start(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as StartRequest;
    res.json(await conexionesService.start(body.day, playerOf(req), body.contentVersion));
  },
  async open(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as MoveRequest;
    res.json(await conexionesService.open(playerOf(req), body.runId, body.version));
  },
  async guess(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as GuessRequest;
    res.json(await conexionesService.guess(playerOf(req), body.runId, body.version, body.ids));
  },
  async current(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await conexionesService.current(playerOf(req), query.day));
  },
  async boards(_req: Request, res: Response): Promise<void> {
    const index = await conexionesService.boards();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(index);
  },
  /** Only closed days are served, and a closed day only changes through a (rare) correction. */
  async review(req: Request, res: Response): Promise<void> {
    const { day } = req.validated.query as ReviewQuery;
    const review = await conexionesService.review(day);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(review);
  },
  /** Members see their own row in `me`; guests are never on the board. */
  async leaderboard(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    const board = await conexionesService.leaderboard(query.day, req.user?.id ?? null);
    const anonymous = !req.headers.authorization && !req.cookies?.qb_access_token;
    res.setHeader('Cache-Control', anonymous ? 'public, max-age=15' : 'private, no-store');
    res.json(board);
  },
};
