import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { rankedController } from '../../modules/ranked/ranked.controller.js';
import { leaderboardResetBodySchema } from '../../modules/ranked/index.js';

const router = Router();

router.use(authMiddleware, requireRole('admin'));

/**
 * POST /api/v1/admin/leaderboard/reset
 * Archive current standings, then zero every real user's RP for an event.
 */
router.post(
  '/reset',
  validate({ body: leaderboardResetBodySchema }),
  rankedController.resetLeaderboard
);

export const adminLeaderboardRoutes = router;
