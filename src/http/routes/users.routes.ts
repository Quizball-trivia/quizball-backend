import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { usersController } from '../../modules/users/index.js';
import { updateProfileSchema } from '../../modules/users/index.js';

const router = Router();

// All users routes require authentication
router.use(authMiddleware);

/**
 * GET /api/v1/users/me
 * Get current user profile.
 */
router.get('/me', usersController.getMe);

/**
 * PUT /api/v1/users/me
 * Update current user profile.
 */
router.put(
  '/me',
  validate({ body: updateProfileSchema }),
  usersController.updateMe
);

/**
 * POST /api/v1/users/me/complete-onboarding
 * Mark onboarding as complete.
 */
router.post('/me/complete-onboarding', usersController.completeOnboarding);

export const usersRoutes = router;
