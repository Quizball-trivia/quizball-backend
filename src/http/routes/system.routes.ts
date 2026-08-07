import { Router, Request, Response } from 'express';
import { buildSystemStatus } from '../../realtime/services/system-status.service.js';

const router = Router();

/**
 * GET /api/v1/system/status
 *
 * Unauthenticated, DB-free liveness of the write path from the client's point
 * of view. Serves the in-memory read-only breaker snapshot only, so it stays
 * up and truthful during the very outage it reports. Used as a poll fallback
 * by the web client when its socket is down >10s (socket delivery is primary).
 *
 * Cache-Control max-age=5: cheap to serve, and a few seconds of staleness is
 * fine for a "matchmaking paused" banner while it keeps CDN/proxy load flat.
 */
router.get('/api/v1/system/status', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'public, max-age=5');
  res.json(buildSystemStatus());
});

export const systemRoutes = router;
