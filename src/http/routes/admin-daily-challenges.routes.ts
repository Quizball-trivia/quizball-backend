import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { validate } from '../middleware/validate.js';
import {
  dailyChallengeParamSchema,
  dailyChallengesController,
  updateDailyChallengeConfigSchema,
} from '../../modules/daily-challenges/index.js';

const router = Router();

router.use(authMiddleware, requireRole('admin'));

router.get('/', dailyChallengesController.listAdmin);

router.put(
  '/:challengeType',
  validate({ params: dailyChallengeParamSchema, body: updateDailyChallengeConfigSchema }),
  dailyChallengesController.updateAdmin
);

export const adminDailyChallengesRoutes = router;
