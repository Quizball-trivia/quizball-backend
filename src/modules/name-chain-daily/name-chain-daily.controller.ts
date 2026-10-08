import type { Request, Response } from 'express';
import { playerOf, type AnswerRequest, type DayQuery, type MoveRequest, type NameReportRequest, type ReviewQuery, type StartRequest } from '../wordgame-daily/wordgame-daily.shared.js';
import { nameChainDailyService } from './name-chain-daily.service.js';

export const nameChainDailyController = {
  async start(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as StartRequest;
    res.json(await nameChainDailyService.start(body.day, playerOf(req), body.contentVersion));
  },
  async next(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as MoveRequest;
    res.json(await nameChainDailyService.next(playerOf(req), body.runId, body.version));
  },
  async answer(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as AnswerRequest;
    res.json(await nameChainDailyService.answer(playerOf(req), body.runId, body.version, body.answer));
  },
  async pass(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as MoveRequest;
    res.json(await nameChainDailyService.pass(playerOf(req), body.runId, body.version));
  },
  async report(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as NameReportRequest;
    await nameChainDailyService.report(playerOf(req), body.day, body.text);
    res.status(204).end();
  },
  async current(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await nameChainDailyService.current(playerOf(req), query.day));
  },
  async boards(_req: Request, res: Response): Promise<void> {
    const index = await nameChainDailyService.boards();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(index);
  },
  /** Only closed days are served, and a closed day only changes through a (rare) correction. */
  async review(req: Request, res: Response): Promise<void> {
    const { day } = req.validated.query as ReviewQuery;
    const review = await nameChainDailyService.review(day);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(review);
  },
  /** Members see their own row in `me`; guests are never on the board. */
  async leaderboard(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    const board = await nameChainDailyService.leaderboard(query.day, req.user?.id ?? null);
    const anonymous = !req.headers.authorization && !req.cookies?.qb_access_token;
    res.setHeader('Cache-Control', anonymous ? 'public, max-age=15' : 'private, no-store');
    res.json(board);
  },
};
