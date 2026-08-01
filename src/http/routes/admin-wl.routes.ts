import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { wlAdminController } from '../../modules/weekend-league/wl-admin.controller.js';

const router = Router();

router.use(authMiddleware, requireRole('admin'));

router.get('/tournaments', wlAdminController.listTournaments);
router.get('/tournaments/:id', wlAdminController.tournamentDetail);
router.post('/create-test', wlAdminController.createTest);
router.post('/tournaments/:id/pause', wlAdminController.pause);
router.post('/tournaments/:id/resume', wlAdminController.resume);
router.post('/tournaments/:id/cancel', wlAdminController.cancel);
router.post('/tournaments/:id/fill-bots', wlAdminController.fillBots);
router.post('/force-tick', wlAdminController.forceTick);

export const adminWlRoutes = router;
