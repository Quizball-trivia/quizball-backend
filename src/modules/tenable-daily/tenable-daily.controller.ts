import type { Request, Response } from 'express';
import { z } from 'zod';
import { answerSchema, playerOf, type DayQuery, type MoveRequest, type NameReportRequest, type ReviewQuery, type StartRequest } from '../wordgame-daily/wordgame-daily.shared.js';
import { tenableDailyService } from './tenable-daily.service.js';

/** An answer, typed or picked from the suggestions (then `pick` is the entity id). */
export const sayRequestSchema = answerSchema.extend({ pick: z.string().min(1).max(64).nullable().optional() });
type SayRequest = z.infer<typeof sayRequestSchema>;

export const tenableDailyController = {
  async start(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as StartRequest;
    res.json(await tenableDailyService.start(body.day, playerOf(req), body.contentVersion, body.locale));
  },
  async say(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as SayRequest;
    res.json(await tenableDailyService.say(playerOf(req), body.runId, body.version, body.answer, body.pick ?? null));
  },
  async giveUp(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as MoveRequest;
    res.json(await tenableDailyService.giveUp(playerOf(req), body.runId, body.version));
  },
  /** Always 204: whether anything was filed says nothing about the list. */
  async report(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as NameReportRequest;
    await tenableDailyService.report(playerOf(req), body.day, body.text);
    res.status(204).end();
  },
  async current(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await tenableDailyService.current(playerOf(req), query.day));
  },
  async boards(_req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(await tenableDailyService.boards());
  },
  /** Only closed days are served, and a closed day only changes through a (rare) correction. */
  async review(req: Request, res: Response): Promise<void> {
    const { day, locale } = req.validated.query as ReviewQuery;
    const review = await tenableDailyService.review(day, locale);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(review);
  },
  async leaderboard(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    const board = await tenableDailyService.leaderboard(query.day, req.user?.id ?? null);
    const anonymous = !req.headers.authorization && !req.cookies?.qb_access_token;
    res.setHeader('Cache-Control', anonymous ? 'public, max-age=15' : 'private, no-store');
    res.json(board);
  },
};
