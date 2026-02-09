import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  statsController,
  headToHeadQuerySchema,
  recentMatchesQuerySchema,
} from '../../modules/stats/index.js';

const router = Router();

router.use(authMiddleware);

/**
 * GET /api/v1/stats/head-to-head
 * Get head-to-head summary for two users.
 */
router.get(
  '/head-to-head',
  validate({ query: headToHeadQuerySchema }),
  statsController.headToHead
);

/**
 * GET /api/v1/stats/recent-matches
 * Get recent matches for authenticated user.
 */
router.get(
  '/recent-matches',
  validate({ query: recentMatchesQuerySchema }),
  statsController.recentMatches
);

/**
 * GET /api/v1/stats/summary
 * Get aggregate match stats for authenticated user.
 */
router.get('/summary', statsController.summary);

export const statsRoutes = router;
