import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  freeKicksController,
  startRoundSchema,
  dealQuestionSchema,
  answerQuestionSchema,
  shootSchema,
  nextAttackSchema,
  cashoutSchema,
} from '../../modules/free-kicks/index.js';

/**
 * Free Kicks — house-banked solo mode with real coins.
 * All endpoints are authenticated; every mutation is server-authoritative
 * (row-locked, version-gated). The client never learns a correct option or a
 * server seed before the moment the rules reveal it.
 */
const router = Router();

router.use(authMiddleware);

router.post('/rounds', validate({ body: startRoundSchema }), freeKicksController.startRound);
router.get('/rounds/current', freeKicksController.getCurrent);
router.post(
  '/rounds/question',
  validate({ body: dealQuestionSchema }),
  freeKicksController.dealQuestion
);
router.post(
  '/rounds/answer',
  validate({ body: answerQuestionSchema }),
  freeKicksController.answerQuestion
);
router.post('/rounds/shoot', validate({ body: shootSchema }), freeKicksController.shoot);
router.post(
  '/rounds/next-attack',
  validate({ body: nextAttackSchema }),
  freeKicksController.nextAttack
);
router.post('/rounds/cashout', validate({ body: cashoutSchema }), freeKicksController.cashout);
router.post('/rounds/heartbeat', freeKicksController.heartbeat);
router.get('/stats', freeKicksController.stats);

export { router as freeKicksRoutes };
