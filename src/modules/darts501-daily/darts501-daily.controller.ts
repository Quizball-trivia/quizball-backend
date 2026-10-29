import type { Request, Response } from 'express';
import { z } from 'zod';
import { answerSchema, playerOf, type DayQuery, type MoveRequest, type NameReportRequest, type ReviewQuery, type StartRequest } from '../wordgame-daily/wordgame-daily.shared.js';
import { darts501DailyService } from './darts501-daily.service.js';

/** A dart, typed or picked from the suggestions (then `pick` is the footballer's id). */
export const throwRequestSchema = answerSchema.extend({ pick: z.string().min(1).max(64).nullable().optional() });
type ThrowRequest = z.infer<typeof throwRequestSchema>;

export const darts501DailyController = {
  async start(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as StartRequest;
    res.json(await darts501DailyService.start(body.day, playerOf(req), body.contentVersion, body.locale));
  },
  async say(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as ThrowRequest;
    res.json(await darts501DailyService.say(playerOf(req), body.runId, body.version, body.answer, body.pick ?? null));
  },
  async giveUp(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as MoveRequest;
    res.json(await darts501DailyService.giveUp(playerOf(req), body.runId, body.version));
  },
  /** Always 204: whether anything was filed says nothing about the category. */
  async report(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as NameReportRequest;
    await darts501DailyService.report(playerOf(req), body.day, body.text);
    res.status(204).end();
  },
  async current(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await darts501DailyService.current(playerOf(req), query.day));
  },
  async boards(_req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(await darts501DailyService.boards());
  },
  /** Only closed days are served, and a closed day only changes through a (rare) correction. */
  async review(req: Request, res: Response): Promise<void> {
    const { day, locale } = req.validated.query as ReviewQuery;
    const review = await darts501DailyService.review(day, locale);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(review);
  },
  async leaderboard(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    const board = await darts501DailyService.leaderboard(query.day, req.user?.id ?? null);
    const anonymous = !req.headers.authorization && !req.cookies?.qb_access_token;
    res.setHeader('Cache-Control', anonymous ? 'public, max-age=15' : 'private, no-store');
    res.json(board);
  },
};
