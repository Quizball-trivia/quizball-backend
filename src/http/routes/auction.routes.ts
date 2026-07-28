import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auctionLeaderboardController } from '../../modules/auction/auction-leaderboard.controller.js';
import {
  auctionLeaderboardQuerySchema,
  auctionUserRankQuerySchema,
} from '../../modules/auction/auction-leaderboard.schemas.js';

const router = Router();

router.use(authMiddleware);

/**
 * GET /api/v1/auction/leaderboard?scope=global|country&limit=50&offset=0
 * Auction leaderboard entries sorted by Auction Points descending.
 */
router.get(
  '/leaderboard',
  validate({ query: auctionLeaderboardQuerySchema }),
  auctionLeaderboardController.getLeaderboard
);

/**
 * GET /api/v1/auction/leaderboard/me?scope=global|country
 * The authenticated user's auction rank; null when they have no AP yet.
 */
router.get(
  '/leaderboard/me',
  validate({ query: auctionUserRankQuerySchema }),
  auctionLeaderboardController.getUserRank
);

export const auctionRoutes = router;
