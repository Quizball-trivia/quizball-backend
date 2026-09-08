import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { triviaMinesController, startRoundSchema, pickSchema, dealQuestionSchema, answerQuestionSchema, cashoutSchema } from '../../modules/trivia-mines/index.js';

/** Trivia Mines — house-banked solo mini game with real coins; every mutation is row-locked and version-gated. */
const router = Router();
router.use(authMiddleware);

router.post('/rounds', validate({ body: startRoundSchema }), triviaMinesController.startRound);
router.get('/rounds/current', triviaMinesController.getCurrent);
router.get('/rounds/latest', triviaMinesController.getLatest);
router.post('/rounds/pick', validate({ body: pickSchema }), triviaMinesController.pick);
router.post('/rounds/question', validate({ body: dealQuestionSchema }), triviaMinesController.dealQuestion);
router.post('/rounds/answer', validate({ body: answerQuestionSchema }), triviaMinesController.answerQuestion);
router.post('/rounds/cashout', validate({ body: cashoutSchema }), triviaMinesController.cashout);
router.post('/rounds/heartbeat', triviaMinesController.heartbeat);
router.get('/stats', triviaMinesController.stats);

export { router as triviaMinesRoutes };
