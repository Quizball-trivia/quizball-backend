import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import {
  usersController,
  userIdParamSchema,
  adminUsersListQuerySchema,
  adminSetProgressionBodySchema,
  adminBanUserBodySchema,
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

/**
 * POST /api/v1/admin/users/:userId/ban
 * Soft-ban an account: blocks login, zeroes RP (snapshotted for restore),
 * keeps all history.
 */
router.post(
  '/:userId/ban',
  validate({ params: userIdParamSchema, body: adminBanUserBodySchema }),
  usersController.banUser
);

/**
 * POST /api/v1/admin/users/:userId/unban
 * Lift a ban and restore snapshotted RP.
 */
router.post(
  '/:userId/unban',
  validate({ params: userIdParamSchema }),
  usersController.unbanUser
);

export const adminUsersRoutes = router;
