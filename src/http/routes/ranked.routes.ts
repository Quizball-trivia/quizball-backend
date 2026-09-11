import { Router } from 'express';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import { rankedController } from '../../modules/ranked/ranked.controller.js';
import { validate } from '../middleware/validate.js';
import {
  rankedLeaderboardQuerySchema,
  rankedUserRankQuerySchema,
} from '../../modules/ranked/ranked.schemas.js';

const router = Router();

/**
 * GET /api/v1/ranked/leaderboard?scope=global|country&limit=50&offset=0
 * Leaderboard entries sorted by RP descending. Readable without an account
 * (signed-out visitors browse the board); the country scope needs a session.
 */
router.get(
  '/leaderboard',
  optionalAuthMiddleware,
  validate({ query: rankedLeaderboardQuerySchema }),
  rankedController.getLeaderboard
);

router.get('/leaderboard/seasons', optionalAuthMiddleware, rankedController.listSeasons);

router.use(authMiddleware);

/**
 * GET /api/v1/ranked/profile
 * Get the authenticated user's ranked profile (RP, tier, placement status).
 */
router.get('/profile', rankedController.getProfile);

/**
 * GET /api/v1/ranked/leaderboard/me?scope=global|country
 * Get the authenticated user's rank position.
 */
router.get(
  '/leaderboard/me',
  validate({ query: rankedUserRankQuerySchema }),
  rankedController.getUserRank
);

export const rankedRoutes = router;
