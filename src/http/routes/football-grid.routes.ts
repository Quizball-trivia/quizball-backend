import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { footballGridLeaderboardController } from '../../modules/football-grid/football-grid-leaderboard.controller.js';
import { footballGridTypeaheadController } from '../../modules/football-grid/football-grid-typeahead.controller.js';
import { footballGridPackPreviewController } from '../../modules/football-grid/football-grid-pack-preview.controller.js';
import {
  footballGridLeaderboardQuerySchema,
  footballGridUserRankQuerySchema,
} from '../../modules/football-grid/football-grid-leaderboard.schemas.js';

const router = Router();

router.use(authMiddleware);

router.get(
  '/leaderboard',
  validate({ query: footballGridLeaderboardQuerySchema }),
  footballGridLeaderboardController.getLeaderboard,
);

router.get(
  '/leaderboard/me',
  validate({ query: footballGridUserRankQuerySchema }),
  footballGridLeaderboardController.getUserRank,
);

router.get(
  '/typeahead',
  footballGridTypeaheadController.getPlayers,
);

router.get(
  '/pack-preview',
  footballGridPackPreviewController.getPreview,
);

export const footballGridRoutes = router;
