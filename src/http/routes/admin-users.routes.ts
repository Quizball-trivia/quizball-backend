import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { usersController, userIdParamSchema } from '../../modules/users/index.js';

const router = Router();

router.use(authMiddleware, requireRole('admin'));

router.post(
  '/:userId/deletion/restore',
  validate({ params: userIdParamSchema }),
  usersController.restorePendingDeletion
);

export const adminUsersRoutes = router;
