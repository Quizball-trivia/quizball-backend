import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireRole } from '../middleware/require-role.js';
import { wlAdminController } from '../../modules/weekend-league/wl-admin.controller.js';
import { wlContentController } from '../../modules/weekend-league/wl-content.controller.js';

const router = Router();

router.use(authMiddleware, requireRole('admin'));

// Editor content import (CMS → wl_private pool). Bodies are zod-parsed in the
// controller; the question shape is the bulk-create one the CMS already builds.
router.post('/content/check', wlContentController.check);
router.post('/content/import', wlContentController.import);
router.get('/content/batches', wlContentController.batches);
router.get('/content/batches/:id', wlContentController.batch);
router.delete('/content/batches/:id', wlContentController.undoBatch);
router.post('/content/batches/:id/schedule', wlContentController.scheduleBatch);
router.get('/content/runway', wlContentController.runway);
router.get('/content/next-event', wlContentController.nextEvent);
router.get('/content/lineup/events', wlContentController.lineupEvents);
router.post('/content/lineup/preview', wlContentController.lineupPreview);
router.post('/content/lineup/save', wlContentController.lineupSave);
router.post('/content/tournaments/:id/reseed', wlContentController.reseed);

router.get('/tournaments', wlAdminController.listTournaments);
router.get('/tournaments/:id', wlAdminController.tournamentDetail);
router.post('/create-test', wlAdminController.createTest);
router.post('/tournaments/:id/pause', wlAdminController.pause);
router.post('/tournaments/:id/resume', wlAdminController.resume);
router.post('/tournaments/:id/cancel', wlAdminController.cancel);
router.post('/tournaments/:id/fill-bots', wlAdminController.fillBots);
router.delete('/tournaments/:id', wlAdminController.deleteTest);
router.get('/stock', wlAdminController.stock);
router.post('/force-tick', wlAdminController.forceTick);

export const adminWlRoutes = router;
