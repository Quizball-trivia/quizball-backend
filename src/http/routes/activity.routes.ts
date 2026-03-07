import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import {
  activityController,
  activityQuerySchema,
  activityByCategoryQuerySchema,
  recentActivityQuerySchema,
} from '../../modules/activity/index.js';

const router = Router();

// All activity endpoints require admin auth
// Additional bighead email check is in the controller

router.get(
  '/',
  authMiddleware,
  requireRole('admin'),
  validate({ query: activityQuerySchema }),
  activityController.getActivity
);

router.get(
  '/users',
  authMiddleware,
  requireRole('admin'),
  activityController.getUsers
);

router.get(
  '/by-category',
  authMiddleware,
  requireRole('admin'),
  validate({ query: activityByCategoryQuerySchema }),
  activityController.getByCategory
);

router.get(
  '/recent',
  authMiddleware,
  requireRole('admin'),
  validate({ query: recentActivityQuerySchema }),
  activityController.getRecent
);

export const activityRoutes = router;
