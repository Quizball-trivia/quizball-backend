import type { Request, Response } from 'express';
import { squadSpinService } from './squad-spin.service.js';
import { config } from '../../core/config.js';
import { AppError } from '../../core/errors.js';
import type { AnswerRequest, DecisionRequest, StartRoundRequest } from './squad-spin.schemas.js';

/** HTTP <-> service only; every handler assumes authMiddleware populated req.user. */
export const squadSpinController = {
  async startRound(req: Request, res: Response): Promise<void> {
    // Kill switch blocks only NEW rounds — open runs can always resume or settle.
    if (!config.SQUAD_SPIN_ENABLED) throw new AppError('Squad Spin is currently disabled', 503);
    const body = req.validated.body as StartRoundRequest;
    res.status(201).json(await squadSpinService.startRound(req.user!.id, { stakeCoins: body.stake, reels: body.reels, clientNonce: body.client_nonce ?? null }));
  },
  async getCurrent(req: Request, res: Response): Promise<void> {
    res.json(await squadSpinService.getCurrentState(req.user!.id));
  },
  /** The player's most recent round in any state, so a run settled by the sweeper can still be shown. */
  async getLatest(req: Request, res: Response): Promise<void> {
    res.json(await squadSpinService.getLatestState(req.user!.id));
  },
  async answer(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as AnswerRequest;
    res.json(await squadSpinService.answer(req.user!.id, { roundId: body.round_id, text: body.text, expectedVersion: body.expected_version }));
  },
  async continueRound(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as DecisionRequest;
    res.json(await squadSpinService.continueRound(req.user!.id, { roundId: body.round_id, expectedVersion: body.expected_version }));
  },
  async cashout(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as DecisionRequest;
    res.json(await squadSpinService.cashout(req.user!.id, { roundId: body.round_id, expectedVersion: body.expected_version }));
  },
  async stats(_req: Request, res: Response): Promise<void> {
    res.json(await squadSpinService.getStats());
  },
  async heartbeat(req: Request, res: Response): Promise<void> {
    await squadSpinService.heartbeat(req.user!.id);
    res.status(204).end();
  },
};
