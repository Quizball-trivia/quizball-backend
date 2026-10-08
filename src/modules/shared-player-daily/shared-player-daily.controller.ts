import type { Request, Response } from 'express';
import { playerOf, type AnswerRequest, type DayQuery, type MoveRequest, type PairReportRequest, type ReviewQuery, type StartRequest } from '../wordgame-daily/wordgame-daily.shared.js';
import { sharedPlayerDailyService } from './shared-player-daily.service.js';

export const sharedPlayerDailyController = {
  async start(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as StartRequest;
    res.json(await sharedPlayerDailyService.start(body.day, playerOf(req), body.contentVersion));
  },
  async next(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as MoveRequest;
    res.json(await sharedPlayerDailyService.next(playerOf(req), body.runId, body.version));
  },
  async answer(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as AnswerRequest;
    res.json(await sharedPlayerDailyService.answer(playerOf(req), body.runId, body.version, body.answer));
  },
  async report(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as PairReportRequest;
    await sharedPlayerDailyService.report(playerOf(req), body.day, body.pair, body.text);
    res.status(204).end();
  },
  async current(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await sharedPlayerDailyService.current(playerOf(req), query.day));
  },
  async boards(_req: Request, res: Response): Promise<void> {
    const index = await sharedPlayerDailyService.boards();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(index);
  },
  /** Only closed days are served, and a closed day only changes through a (rare) correction. */
  async review(req: Request, res: Response): Promise<void> {
    const { day } = req.validated.query as ReviewQuery;
    const review = await sharedPlayerDailyService.review(day);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(review);
  },
  /** Members see their own row in `me`; guests are never on the board. */
  async leaderboard(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    const board = await sharedPlayerDailyService.leaderboard(query.day, req.user?.id ?? null);
    const anonymous = !req.headers.authorization && !req.cookies?.qb_access_token;
    res.setHeader('Cache-Control', anonymous ? 'public, max-age=15' : 'private, no-store');
    res.json(board);
  },
};
