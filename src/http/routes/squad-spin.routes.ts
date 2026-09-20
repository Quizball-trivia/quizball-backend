import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { squadSpinController, startRoundSchema, answerSchema, decisionSchema } from '../../modules/squad-spin/index.js';

/** Squad Spin — house-banked solo mini game with real coins; every mutation is row-locked and version-gated. */
const router = Router();
router.use(authMiddleware);

router.post('/rounds', validate({ body: startRoundSchema }), squadSpinController.startRound);
router.get('/rounds/current', squadSpinController.getCurrent);
router.get('/rounds/latest', squadSpinController.getLatest);
router.post('/rounds/answer', validate({ body: answerSchema }), squadSpinController.answer);
router.post('/rounds/continue', validate({ body: decisionSchema }), squadSpinController.continueRound);
router.post('/rounds/cashout', validate({ body: decisionSchema }), squadSpinController.cashout);
router.post('/rounds/heartbeat', squadSpinController.heartbeat);
router.get('/stats', squadSpinController.stats);

export { router as squadSpinRoutes };
