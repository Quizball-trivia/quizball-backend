import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  answerRoadToGoalQuestionSchema,
  cashoutRoadToGoalRoundSchema,
  continueRoadToGoalRoundSchema,
  prepareRoadToGoalCommitmentSchema,
  roadToGoalController,
  roadToGoalRoundParamsSchema,
  startRoadToGoalRoundSchema,
} from '../../modules/road-to-goal/index.js';

/** Authenticated, server-authoritative Road to Goal game API. */
const router = Router();

router.use(authMiddleware);
router.post(
  '/rounds/commitments',
  validate({ body: prepareRoadToGoalCommitmentSchema }),
  roadToGoalController.prepareCommitment
);
router.post(
  '/rounds',
  validate({ body: startRoadToGoalRoundSchema }),
  roadToGoalController.startRound
);
router.get('/rounds/current', roadToGoalController.getCurrent);
router.get(
  '/rounds/:roundId/proof',
  validate({ params: roadToGoalRoundParamsSchema }),
  roadToGoalController.getProof
);
router.get(
  '/rounds/:roundId',
  validate({ params: roadToGoalRoundParamsSchema }),
  roadToGoalController.getRound
);
router.post(
  '/rounds/answer',
  validate({ body: answerRoadToGoalQuestionSchema }),
  roadToGoalController.answerQuestion
);
router.post(
  '/rounds/continue',
  validate({ body: continueRoadToGoalRoundSchema }),
  roadToGoalController.continueRound
);
router.post(
  '/rounds/cashout',
  validate({ body: cashoutRoadToGoalRoundSchema }),
  roadToGoalController.cashout
);
router.post('/rounds/heartbeat', roadToGoalController.heartbeat);

export { router as roadToGoalRoutes };
