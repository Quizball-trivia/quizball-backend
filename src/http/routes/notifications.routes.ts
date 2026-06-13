import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  notificationsController,
  listNotificationsQuerySchema,
  notificationIdParamSchema,
} from '../../modules/notifications/index.js';

const router = Router();

router.use(authMiddleware);

router.get('/', validate({ query: listNotificationsQuerySchema }), notificationsController.list);
router.get('/unread-count', notificationsController.unreadCount);
router.post('/read-all', notificationsController.markAllRead);
router.post(
  '/:notificationId/read',
  validate({ params: notificationIdParamSchema }),
  notificationsController.markRead
);

export const notificationsRoutes = router;
