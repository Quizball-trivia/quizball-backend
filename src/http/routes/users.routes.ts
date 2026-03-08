import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { usersController, updateProfileSchema, userIdParamSchema } from '../../modules/users/index.js';

const router = Router();

// All users routes require authentication
router.use(authMiddleware);

/**
 * GET /api/v1/users/me
 * Get current user profile.
 */
router.get('/me', usersController.getMe);

/**
 * GET /api/v1/users/me/achievements
 * Get current user achievements.
 */
router.get('/me/achievements', usersController.getMyAchievements);

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

/**
 * GET /api/v1/users/:userId/profile
 * Get public profile for a user.
 */
router.get(
  '/:userId/profile',
  validate({ params: userIdParamSchema }),
  usersController.getPublicProfile
);

/**
 * GET /api/v1/users/:userId/achievements
 * Get public achievements for a user.
 */
router.get(
  '/:userId/achievements',
  validate({ params: userIdParamSchema }),
  usersController.getUserAchievements
);

export const usersRoutes = router;
