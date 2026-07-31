import { Router } from 'express';
import { wlOpsController } from '../../modules/weekend-league/wl-ops.controller.js';

// Auth lives in the controller (x-wl-ops-token vs config.WL_OPS_TOKEN; the
// whole surface 404s when the env is unset) — no user auth middleware here,
// this is an operator API, not a player one.
const router = Router();

router.post('/create-test', wlOpsController.createTest);
router.post('/pause', wlOpsController.pause);
router.post('/resume', wlOpsController.resume);
router.post('/cancel', wlOpsController.cancel);
router.post('/force-tick', wlOpsController.forceTick);
router.post('/skip-poison-event', wlOpsController.skipPoisonEvent);

export const wlOpsRoutes = router;
