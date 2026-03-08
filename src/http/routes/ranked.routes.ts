import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { rankedController } from '../../modules/ranked/ranked.controller.js';

const router = Router();

router.use(authMiddleware);

/**
 * GET /api/v1/ranked/profile
 * Get the authenticated user's ranked profile (RP, tier, placement status).
 */
router.get('/profile', rankedController.getProfile);

/**
 * GET /api/v1/ranked/leaderboard?scope=global|country&limit=50&offset=0
 * Get leaderboard entries sorted by RP descending.
 */
router.get('/leaderboard', rankedController.getLeaderboard);

/**
 * GET /api/v1/ranked/leaderboard/me?scope=global|country
 * Get the authenticated user's rank position.
 */
router.get('/leaderboard/me', rankedController.getUserRank);

export const rankedRoutes = router;
