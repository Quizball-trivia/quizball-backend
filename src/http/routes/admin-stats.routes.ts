import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { adminStatsController } from '../../modules/admin-stats/index.js';

const router = Router();

router.use(authMiddleware, requireRole('admin'));

/**
 * GET /api/v1/admin/stats/overview
 * Real-user totals + 7-day signups/DAU/match trend for the CMS dashboard.
 */
router.get('/overview', adminStatsController.getOverview);

export const adminStatsRoutes = router;
