import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { usersController } from '../../modules/users/index.js';
import { adminPersonsController, adminStatsController } from '../../modules/admin-stats/index.js';
import { validate } from '../middleware/validate.js';
import { personsQuerySchema, personParamsSchema } from '../../modules/admin-stats/admin-stats.schemas.js';

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

/**
 * GET /api/v1/admin/stats/persons
 * GET /api/v1/admin/stats/persons/:kind/:id/activity
 * The CMS Persons tab: browse real users/guests and one person's DB journey.
 */
router.get('/persons', validate({ query: personsQuerySchema }), adminPersonsController.list);
router.get('/persons/:kind/:id/activity', validate({ params: personParamsSchema }), adminPersonsController.activity);

export const adminStatsRoutes = router;
