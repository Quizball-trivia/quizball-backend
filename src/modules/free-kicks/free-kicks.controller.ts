import type { Request, Response } from 'express';
import { freeKicksService } from './free-kicks.service.js';
import { config } from '../../core/config.js';
import { AppError } from '../../core/errors.js';
import type {
  AnswerQuestionRequest,
  CashoutRequest,
  DealQuestionRequest,
  NextAttackRequest,
  ShootRequest,
  StartRoundRequest,
} from './free-kicks.schemas.js';

/**
 * Free Kicks controller. HTTP <-> service only; all game logic lives in the
 * service. Every handler assumes authMiddleware populated req.user.
 */
export const freeKicksController = {
  async startRound(req: Request, res: Response): Promise<void> {
    // Kill switch blocks only NEW rounds — everything else keeps working so
    // existing pots can always resume or settle.
    if (!config.FREE_KICKS_ENABLED) {
      throw new AppError('Free Kicks is currently disabled', 503);
    }
    const body = req.validated.body as StartRoundRequest;
    const state = await freeKicksService.startRound(
      req.user!.id,
      body.stake,
      body.client_nonce ?? null
    );
    res.status(201).json(state);
  },

  async getCurrent(req: Request, res: Response): Promise<void> {
    res.json(await freeKicksService.getCurrentState(req.user!.id));
  },

  async dealQuestion(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as DealQuestionRequest;
    res.json(await freeKicksService.dealQuestion(req.user!.id, body.expected_version));
  },

  async answerQuestion(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as AnswerQuestionRequest;
    res.json(
      await freeKicksService.answerQuestion(req.user!.id, {
        questionId: body.question_id,
        optionId: body.option_id,
        expectedVersion: body.expected_version,
      })
    );
  },

  async shoot(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as ShootRequest;
    res.json(
      await freeKicksService.shoot(req.user!.id, {
        zone: body.zone,
        expectedVersion: body.expected_version,
      })
    );
  },

  async nextAttack(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as NextAttackRequest;
    res.json(
      await freeKicksService.nextAttack(req.user!.id, {
        expectedVersion: body.expected_version,
        clientNonce: body.client_nonce ?? null,
      })
    );
  },

  async cashout(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as CashoutRequest;
    res.json(await freeKicksService.cashout(req.user!.id, body.expected_version));
  },

  /** Live stats for the social strip/leaderboard — real rows, small cache. */
  async stats(_req: Request, res: Response): Promise<void> {
    res.json(await freeKicksService.getStats());
  },

  /** Heartbeat + sendBeacon target: cheap, never throws to the client. */
  async heartbeat(req: Request, res: Response): Promise<void> {
    await freeKicksService.heartbeat(req.user!.id);
    res.status(204).end();
  },
};
