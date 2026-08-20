import type { Request, Response } from 'express';
import { config } from '../../core/config.js';
import { AppError } from '../../core/errors.js';
import type {
  AnswerRoadToGoalQuestionRequest,
  CashoutRoadToGoalRoundRequest,
  ContinueRoadToGoalRoundRequest,
  PrepareRoadToGoalCommitmentRequest,
  RoadToGoalRoundParams,
  StartRoadToGoalRoundRequest,
} from './road-to-goal.schemas.js';
import { roadToGoalService } from './road-to-goal.service.js';

export const roadToGoalController = {
  async prepareCommitment(req: Request, res: Response): Promise<void> {
    if (!config.ROAD_TO_GOAL_ENABLED) {
      throw new AppError('Road to Goal is currently disabled', 503);
    }
    const body = req.validated.body as PrepareRoadToGoalCommitmentRequest;
    const commitment = await roadToGoalService.prepareCommitment(req.user!.id, {
      stakeCoins: body.stake,
      requestNonce: body.request_nonce,
      autoCashoutZone: body.auto_cashout_zone,
    });
    res.status(201).json(commitment);
  },

  async startRound(req: Request, res: Response): Promise<void> {
    if (!config.ROAD_TO_GOAL_ENABLED) {
      throw new AppError('Road to Goal is currently disabled', 503);
    }
    const body = req.validated.body as StartRoadToGoalRoundRequest;
    const state = await roadToGoalService.startRound(req.user!.id, {
      commitmentId: body.commitment_id,
      clientNonce: body.client_nonce,
      clientSeed: body.client_seed,
    });
    res.status(201).json(state);
  },

  async getCurrent(req: Request, res: Response): Promise<void> {
    res.json(await roadToGoalService.getCurrentState(req.user!.id));
  },

  async getRound(req: Request, res: Response): Promise<void> {
    const params = req.validated.params as RoadToGoalRoundParams;
    res.json(await roadToGoalService.getRoundState(req.user!.id, params.roundId));
  },

  async answerQuestion(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as AnswerRoadToGoalQuestionRequest;
    res.json(
      await roadToGoalService.answerQuestion(req.user!.id, {
        roundId: body.round_id,
        questionId: body.question_id,
        optionId: body.option_id,
        expectedVersion: body.expected_version,
        requestNonce: body.request_nonce,
      })
    );
  },

  async continueRound(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as ContinueRoadToGoalRoundRequest;
    res.json(
      await roadToGoalService.continueRound(req.user!.id, {
        roundId: body.round_id,
        expectedVersion: body.expected_version,
        requestNonce: body.request_nonce,
      })
    );
  },

  async cashout(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as CashoutRoadToGoalRoundRequest;
    res.json(
      await roadToGoalService.cashout(req.user!.id, {
        roundId: body.round_id,
        expectedVersion: body.expected_version,
        requestNonce: body.request_nonce,
      })
    );
  },

  async getProof(req: Request, res: Response): Promise<void> {
    const params = req.validated.params as RoadToGoalRoundParams;
    res.json(await roadToGoalService.getProof(req.user!.id, params.roundId));
  },

  async heartbeat(req: Request, res: Response): Promise<void> {
    await roadToGoalService.heartbeat(req.user!.id);
    res.status(204).end();
  },
};
