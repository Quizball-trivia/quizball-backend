import { Router, Request, Response } from 'express';
import { dbPoolStats, withStatementTimeout } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import {
  postConnectDbTaskLimiter,
  socketDbTaskLimiter,
} from '../../realtime/socket-db-task-limiter.js';

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
    // Run the probe inside a transaction with a 2s SET LOCAL statement_timeout so
    // Postgres ITSELF aborts a hung probe (no orphaned query holding a slot —
    // unlike a Promise.race that only abandons the wait). 5s overall ceiling as
    // a backstop for the connection-acquire phase.
    await withStatementTimeout(async (tx) => {
      await tx.unsafe('SELECT 1');
    }, 2000);
    res.json({
      ok: true,
      durationMs: Date.now() - started,
      pool: stats,
      socketDbTasks: socketDbTaskLimiter.stats(),
      postConnectDbTasks: postConnectDbTaskLimiter.stats(),
    });
  } catch (error) {
    logger.error({ error, durationMs: Date.now() - started, pool: stats }, 'health/db probe failed');
    res.status(503).json({
      ok: false,
      durationMs: Date.now() - started,
      pool: stats,
      socketDbTasks: socketDbTaskLimiter.stats(),
      postConnectDbTasks: postConnectDbTaskLimiter.stats(),
    });
  }
});

export const healthRoutes = router;
