import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import {
  announcementsController,
  createAnnouncementBodySchema,
  updateAnnouncementBodySchema,
  announcementIdParamSchema,
} from '../../modules/announcements/index.js';

// Admin-only announcement management (create / edit / toggle / delete).
const router = Router();

router.use(authMiddleware, requireRole('admin'));

router.get('/', announcementsController.listAll);

router.post(
  '/',
  validate({ body: createAnnouncementBodySchema }),
  announcementsController.create
);

router.patch(
  '/:announcementId',
  validate({ params: announcementIdParamSchema, body: updateAnnouncementBodySchema }),
  announcementsController.update
);

router.delete(
  '/:announcementId',
  validate({ params: announcementIdParamSchema }),
  announcementsController.remove
);

export const adminAnnouncementsRoutes = router;
