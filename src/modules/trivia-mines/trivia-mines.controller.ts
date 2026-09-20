import type { Request, Response } from 'express';
import { triviaMinesService } from './trivia-mines.service.js';
import { config } from '../../core/config.js';
import { AppError } from '../../core/errors.js';
import type { AnswerQuestionRequest, CashoutRequest, DealQuestionRequest, PickRequest, StartRoundRequest } from './trivia-mines.schemas.js';

/** HTTP <-> service only; every handler assumes authMiddleware populated req.user. */
export const triviaMinesController = {
  async startRound(req: Request, res: Response): Promise<void> {
    // Kill switch blocks only NEW rounds — open pots can always resume or settle.
    if (!config.TRIVIA_MINES_ENABLED) throw new AppError('Trivia Mines is currently disabled', 503);
    const body = req.validated.body as StartRoundRequest;
    res.status(201).json(await triviaMinesService.startRound(req.user!.id, body.stake, body.client_nonce ?? null));
  },
  async getCurrent(req: Request, res: Response): Promise<void> {
    res.json(await triviaMinesService.getCurrentState(req.user!.id));
  },
  async getLatest(req: Request, res: Response): Promise<void> {
    res.json(await triviaMinesService.getLatestState(req.user!.id));
  },
  async pick(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as PickRequest;
    res.json(await triviaMinesService.pick(req.user!.id, { roundId: body.round_id, tile: body.tile, expectedVersion: body.expected_version }));
  },
  async dealQuestion(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as DealQuestionRequest;
    res.json(await triviaMinesService.dealQuestion(req.user!.id, { roundId: body.round_id, expectedVersion: body.expected_version }));
  },
  async answerQuestion(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as AnswerQuestionRequest;
    res.json(await triviaMinesService.answerQuestion(req.user!.id, { roundId: body.round_id, questionId: body.question_id, optionId: body.option_id, expectedVersion: body.expected_version }));
  },
  async cashout(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as CashoutRequest;
    res.json(await triviaMinesService.cashout(req.user!.id, { roundId: body.round_id, expectedVersion: body.expected_version }));
  },
  async stats(_req: Request, res: Response): Promise<void> {
    res.json(await triviaMinesService.getStats());
  },
  async heartbeat(req: Request, res: Response): Promise<void> {
    await triviaMinesService.heartbeat(req.user!.id);
    res.status(204).end();
  },
};
