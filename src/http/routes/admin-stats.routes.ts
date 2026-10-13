import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { usersController } from '../../modules/users/index.js';

const router = Router();

router.use(authMiddleware, requireRole('admin'));

/**
 * GET /api/v1/admin/stats/user-total
 * Guest-inclusive user total for the CMS dashboard (read-only).
 * total = registered + guestsPlayed - converters.
 */
router.get('/user-total', usersController.userTotal);

export const adminStatsRoutes = router;
