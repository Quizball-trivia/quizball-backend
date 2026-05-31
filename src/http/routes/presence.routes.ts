import { Router } from 'express';
import { presenceController } from '../../modules/presence/index.js';

const router = Router();

/**
 * POST /api/v1/presence/ping
 * Heartbeat from any open tab (anonymous or logged-in). Records the visitor as
 * online and returns the current site-wide count. Public — never rejects.
 */
router.post('/ping', presenceController.ping);

/**
 * GET /api/v1/presence/online
 * Current site-wide online count without recording a ping.
 */
router.get('/online', presenceController.online);

export const presenceRoutes = router;
