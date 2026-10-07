import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import rateLimit from 'express-rate-limit';
import { mobilePushController,requirePushBearer } from '../../modules/notifications/mobile-push.controller.js';
import { registerPushDeviceSchema,unregisterPushDeviceSchema,updatePushPreferencesSchema,pushCampaignSchema } from '../../modules/notifications/mobile-push.schemas.js';
import {
  notificationsController,
  listNotificationsQuerySchema,
  notificationIdParamSchema,
} from '../../modules/notifications/index.js';

const router = Router();

router.use(authMiddleware);
const pushLimit=rateLimit({windowMs:60_000,limit:20,keyGenerator:req=>req.user!.id,standardHeaders:'draft-7',legacyHeaders:false});
const pushTestLimit=rateLimit({windowMs:60_000,limit:1,keyGenerator:req=>req.user!.id,standardHeaders:'draft-7',legacyHeaders:false});
router.post('/devices/register',requirePushBearer,pushLimit,validate({body:registerPushDeviceSchema}),mobilePushController.register);
router.post('/devices/unregister',requirePushBearer,pushLimit,validate({body:unregisterPushDeviceSchema}),mobilePushController.unregister);
router.get('/preferences',requirePushBearer,mobilePushController.preferences);
router.patch('/preferences',requirePushBearer,pushLimit,validate({body:updatePushPreferencesSchema}),mobilePushController.updatePreferences);
router.post('/devices/test',requirePushBearer,pushTestLimit,mobilePushController.test);
router.get('/campaigns/preview',requirePushBearer,requireRole('admin'),mobilePushController.preview);
router.post('/campaigns/send',requirePushBearer,requireRole('admin'),pushTestLimit,validate({body:pushCampaignSchema}),mobilePushController.campaign);

router.get('/', validate({ query: listNotificationsQuerySchema }), notificationsController.list);
router.get('/unread-count', notificationsController.unreadCount);
router.post('/read-all', notificationsController.markAllRead);
router.post(
  '/:notificationId/read',
  validate({ params: notificationIdParamSchema }),
  notificationsController.markRead
);

export const notificationsRoutes = router;
