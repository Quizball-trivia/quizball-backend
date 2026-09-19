import { Router, Request, Response } from 'express';
import { hostname } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { dbPoolStats, withStatementTimeout } from '../../db/index.js';
import { cpuCapacityCores } from '../../core/cpu.js';
import { logger } from '../../core/logger.js';
import { authAdmissionStats } from '../../modules/auth/auth-admission.js';
import {
  postConnectDbTaskLimiter,
  socketDbTaskLimiter,
} from '../../realtime/socket-db-task-limiter.js';
import { socketRuntimeTracker } from '../../realtime/socket-runtime-stats.js';

const router = Router();
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
let previousCpuUsage = process.cpuUsage();
let previousCpuAt = performance.now();
const allocatedCpuCores = cpuCapacityCores();

function runtimeStats() {
  const memory = process.memoryUsage();
  const now = performance.now();
  const currentCpuUsage = process.cpuUsage();
  const cpuMicros = currentCpuUsage.user - previousCpuUsage.user
    + currentCpuUsage.system - previousCpuUsage.system;
  const elapsedMs = Math.max(1, now - previousCpuAt);
  const cpuCorePct = (cpuMicros / (elapsedMs * 1_000)) * 100;
  const cpuPct = Math.round((cpuCorePct / allocatedCpuCores) * 10) / 10;
  previousCpuUsage = currentCpuUsage;
  previousCpuAt = now;
  const nsToMs = (value: number) => Number.isFinite(value)
    ? Math.round((value / 1_000_000) * 10) / 10
    : 0;
  const stats = {
    instance: process.env.RAILWAY_REPLICA_ID ?? process.env.HOSTNAME ?? hostname(),
    uptimeSec: Math.round(process.uptime()),
    cpuPct,
    cpuCorePct: Math.round(cpuCorePct * 10) / 10,
    cpuCapacityCores: Math.round(allocatedCpuCores * 100) / 100,
    eventLoopDelayMs: {
      mean: nsToMs(eventLoopDelay.mean),
      p95: nsToMs(eventLoopDelay.percentile(95)),
      p99: nsToMs(eventLoopDelay.percentile(99)),
      max: nsToMs(eventLoopDelay.max),
    },
    memoryMb: {
      rss: Math.round(memory.rss / 1_048_576),
      heapUsed: Math.round(memory.heapUsed / 1_048_576),
    },
  };
  eventLoopDelay.reset();
  return stats;
}

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
      pool: dbPoolStats(),
      authAdmission: authAdmissionStats(),
      socketDbTasks: socketDbTaskLimiter.stats(),
      postConnectDbTasks: postConnectDbTaskLimiter.stats(),
      sockets: socketRuntimeTracker.stats(),
      runtime: runtimeStats(),
    });
  } catch (error) {
    const stats = dbPoolStats();
    logger.error({ error, durationMs: Date.now() - started, pool: stats }, 'health/db probe failed');
    res.status(503).json({
      ok: false,
      durationMs: Date.now() - started,
      pool: stats,
      authAdmission: authAdmissionStats(),
      socketDbTasks: socketDbTaskLimiter.stats(),
      postConnectDbTasks: postConnectDbTaskLimiter.stats(),
      sockets: socketRuntimeTracker.stats(),
      runtime: runtimeStats(),
    });
  }
});

export const healthRoutes = router;
