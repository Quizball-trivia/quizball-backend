import type { Request, Response } from 'express';
import { bucketIp } from '../../core/ip-bucket.js';
import { resolveTrustedClientIp } from '../../http/client-ip.js';
import { buscaminasService } from './buscaminas.service.js';
import type { BoardParams, DayQuery, StartRequest, TapRequest, TokenBodyRequest } from './buscaminas.schemas.js';

const userIdOf = (req: Request): string | null => req.user?.id ?? null;

export const buscaminasController = {
  async start(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as StartRequest;
    res.json(await buscaminasService.start(body.day, userIdOf(req), body.contentVersion, bucketIp(resolveTrustedClientIp(req))));
  },
  async tap(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as TapRequest;
    res.json(await buscaminasService.tap(body.token, body.cardId, userIdOf(req)));
  },
  async bank(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as TokenBodyRequest;
    res.json(await buscaminasService.bank(body.token, userIdOf(req)));
  },
  async next(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as TokenBodyRequest;
    res.json(await buscaminasService.next(body.token, userIdOf(req)));
  },
  async current(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    res.json(await buscaminasService.current(req.user!.id, query.day));
  },
  /** A finished day is cached for a day; the live one only for minutes, so it can be corrected the same day. */
  async board(req: Request, res: Response): Promise<void> {
    const { day } = req.validated.params as BoardParams;
    const { board, live } = await buscaminasService.board(day);
    res.setHeader('Cache-Control', live ? 'public, max-age=300' : 'public, max-age=86400');
    res.json(board);
  },
  async boards(_req: Request, res: Response): Promise<void> {
    const index = await buscaminasService.boards();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(index);
  },
  async leaderboard(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as DayQuery;
    const board = await buscaminasService.leaderboard(query.day, userIdOf(req));
    const anonymous = !req.headers.authorization && !req.cookies?.qb_access_token;
    res.setHeader('Cache-Control', anonymous ? 'public, max-age=15' : 'private, no-store');
    res.json(board);
  },
};
