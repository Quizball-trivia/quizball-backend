import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { validate } from '../middleware/validate.js';
import {
  completeDailyChallengeBodySchema,
  dailyChallengeParamSchema,
  dailyChallengesController,
} from '../../modules/daily-challenges/index.js';

const router = Router();

router.use(authMiddleware);

router.get('/', dailyChallengesController.list);

router.post(
  '/:challengeType/session',
  validate({ params: dailyChallengeParamSchema }),
  dailyChallengesController.createSession
);

router.post(
  '/:challengeType/complete',
  validate({ params: dailyChallengeParamSchema, body: completeDailyChallengeBodySchema }),
  dailyChallengesController.complete
);

router.delete(
  '/dev/:challengeType/reset',
  requireRole('admin'),
  validate({ params: dailyChallengeParamSchema }),
  dailyChallengesController.resetDev
);

export const dailyChallengesRoutes = router;
