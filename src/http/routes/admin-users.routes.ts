import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import {
  usersController,
  userIdParamSchema,
  adminUsersListQuerySchema,
  adminSetProgressionBodySchema,
} from '../../modules/users/index.js';

const router = Router();

router.use(authMiddleware, requireRole('admin'));

/**
 * GET /api/v1/admin/users
 * Paginated, searchable list of users with progression, RP and wallet.
 */
router.get(
  '/',
  validate({ query: adminUsersListQuerySchema }),
  usersController.listUsers
);

/**
 * PATCH /api/v1/admin/users/:userId/progression
 * Set or grant a user's XP and/or RP.
 */
router.patch(
  '/:userId/progression',
  validate({ params: userIdParamSchema, body: adminSetProgressionBodySchema }),
  usersController.adminSetProgression
);

router.post(
  '/:userId/deletion/restore',
  validate({ params: userIdParamSchema }),
  usersController.restorePendingDeletion
);

export const adminUsersRoutes = router;
