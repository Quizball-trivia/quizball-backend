import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { statsController, headToHeadQuerySchema } from '../../modules/stats/index.js';

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

export const statsRoutes = router;
