import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  guessTheGoalController,
  startSessionSchema,
  guessSchema,
  bonusSchema,
  sessionIdParamsSchema,
} from '../../modules/guess-the-goal/index.js';

/**
 * Guess the Goal — solo knowledge mini-game. All endpoints authenticated and
 * server-authoritative: the correct option never leaves the backend before the
 * guess, and points decay is computed from the server clock.
 */
const router = Router();

router.use(authMiddleware);

router.post('/sessions', validate({ body: startSessionSchema }), guessTheGoalController.startSession);
router.get('/sessions/current', guessTheGoalController.getCurrent);
router.post(
  '/sessions/:sessionId/guess',
  validate({ params: sessionIdParamsSchema, body: guessSchema }),
  guessTheGoalController.guess
);
router.post(
  '/sessions/:sessionId/bonus',
  validate({ params: sessionIdParamsSchema, body: bonusSchema }),
  guessTheGoalController.answerBonus
);
router.get('/stats', guessTheGoalController.stats);
router.get('/gallery', guessTheGoalController.gallery);

export { router as guessTheGoalRoutes };
