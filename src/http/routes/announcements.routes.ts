import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { announcementsController } from '../../modules/announcements/index.js';

// Public (authed) — the player News feed: active announcements only.
const router = Router();

router.use(authMiddleware);

router.get('/', announcementsController.listActive);

export const announcementsRoutes = router;
