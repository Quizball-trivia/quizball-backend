import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { usersController } from '../../modules/users/index.js';
import { adminStatsController } from '../../modules/admin-stats/index.js';

const router = Router();

router.use(authMiddleware, requireRole('admin'));

/**
 * GET /api/v1/admin/stats/user-total
 * Guest-inclusive user total for the CMS dashboard (read-only).
 * total = registered + guestsPlayed - converters.
 */
router.get('/user-total', usersController.userTotal);

/**
 * GET /api/v1/admin/stats/analytics-overview
 * Real-numbers product analytics from the database (the CMS Analytics page).
 */
router.get('/analytics-overview', adminStatsController.analyticsOverview);

export const adminStatsRoutes = router;
