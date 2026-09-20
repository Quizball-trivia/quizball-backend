import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { validate } from '../middleware/validate.js';
import {
  completeDailyChallengeBodySchema,
  passChainLinkBodySchema,
  dailyChallengeLocaleQuerySchema,
  dailyChallengeParamSchema,
  dailyChallengeRecommendationsQuerySchema,
  dailyChallengesController,
  setDailyComebackReminderBodySchema,
} from '../../modules/daily-challenges/index.js';

const router = Router();

router.use(authMiddleware);

router.get(
  '/',
  validate({ query: dailyChallengeLocaleQuerySchema }),
  dailyChallengesController.list
);

router.get(
  '/recommendations',
  validate({ query: dailyChallengeRecommendationsQuerySchema }),
  dailyChallengesController.recommendations
);

router.get('/comeback', dailyChallengesController.comebackState);

router.put(
  '/comeback/reminder',
  validate({ body: setDailyComebackReminderBodySchema }),
  dailyChallengesController.setComebackReminder
);

router.get('/stat-sniper/leaderboard', dailyChallengesController.statSniperLeaderboard);

router.post(
  '/pass-chain/link',
  validate({ body: passChainLinkBodySchema }),
  dailyChallengesController.passChainLink
);

router.post(
  '/:challengeType/session',
  validate({ params: dailyChallengeParamSchema, query: dailyChallengeLocaleQuerySchema }),
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
