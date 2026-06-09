import { Router, Request, Response } from 'express';
import { sql, dbPoolStats } from '../../db/index.js';
import { logger } from '../../core/logger.js';

const router = Router();

/**
 * GET /health
 * Liveness check — does NOT touch the DB. Stays fast even during DB/pool
 * trouble, so it must not be used to infer DB health (use /health/db for that).
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

/**
 * GET /health/db
 * Readiness check that actually exercises the DB pool: acquires a connection
 * and runs SELECT 1 with a tight timeout. Returns 503 if the pool is exhausted
 * or the DB is unreachable — this is what surfaces the 2026-06-09 incident
 * (when /health stayed green but every DB endpoint hung).
 */
router.get('/health/db', async (_req: Request, res: Response) => {
  const started = Date.now();
  const stats = dbPoolStats();
  try {
    await Promise.race([
      sql`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('db_probe_timeout')), 2000)),
    ]);
    res.json({ ok: true, durationMs: Date.now() - started, pool: stats });
  } catch (error) {
    logger.error({ error, durationMs: Date.now() - started, pool: stats }, 'health/db probe failed');
    res.status(503).json({ ok: false, durationMs: Date.now() - started, pool: stats });
  }
});

export const healthRoutes = router;
