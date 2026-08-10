import { Router, Request, Response } from 'express';
import { hostname } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { dbPoolStats, probeDbWritable, readOnlyDbBreaker } from '../../db/index.js';
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
 * Readiness check that actually exercises the DB pool with a rollback-only
 * WRITE probe. A plain SELECT 1 was not enough: during INC-2026-07-29 the pool
 * handed out connections contaminated with `default_transaction_read_only=on`,
 * so reads passed while every write failed with SQLSTATE 25006 and readiness
 * stayed green. Returns 503 if the pool is exhausted, unreachable, or read-only.
 */
router.get('/health/db', async (_req: Request, res: Response) => {
  const started = Date.now();
  const writable = await probeDbWritable(2_000);
  const breaker = readOnlyDbBreaker.snapshot();
  const body = {
    ok: writable && !breaker.degraded,
    writable,
    dbOutageBreaker: breaker,
    durationMs: Date.now() - started,
    pool: dbPoolStats(),
    authAdmission: authAdmissionStats(),
    socketDbTasks: socketDbTaskLimiter.stats(),
    postConnectDbTasks: postConnectDbTaskLimiter.stats(),
    sockets: socketRuntimeTracker.stats(),
    runtime: runtimeStats(),
  };
  if (body.ok) {
    res.json(body);
    return;
  }
  logger.error(
    { writable, breaker, durationMs: body.durationMs, pool: body.pool },
    'health/db write probe failed'
  );
  res.status(503).json(body);
});

export const healthRoutes = router;
