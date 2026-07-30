import { createServer } from 'http';
import { createApp } from './app.js';
import { config } from './core/config.js';
import { logger } from './core/logger.js';
import { shutdownLokiLogStream } from './core/loki.js';
import { shutdownTelemetry } from './core/otel.js';
import { disconnectDb } from './db/index.js';
import { dbPoolStats, withDbWatchdogProbe, probeDbWritable, readOnlyDbBreaker } from './db/index.js';
import { DbWatchdog } from './db/watchdog.js';
import { initSocketServer } from './realtime/socket-server.js';
import { closeRedisClients } from './realtime/redis.js';
import { shutdownPostHog } from './core/analytics.js';
import { startAiFriendResponder, stopAiFriendResponder } from './modules/friends/ai-friend-responder.service.js';
import {
  startBotChallengeResponder,
  stopBotChallengeResponder,
} from './modules/lobbies/bot-challenge-responder.service.js';
import { startBotRenameWorker, stopBotRenameWorker } from './modules/bots/bot-rename.service.js';

const app = createApp();
const httpServer = createServer(app);
const io = await initSocketServer(httpServer);

const server = httpServer.listen(config.PORT, () => {
  logger.info(
    {
      port: config.PORT,
      env: config.NODE_ENV,
    },
    `Server started on port ${config.PORT} with Socket.IO`
  );
});
startAiFriendResponder();
// Both no-op when PERSISTENT_BOTS_ENABLED is off (checked inside each start).
startBotChallengeResponder();
startBotRenameWorker();

const dbWatchdog = new DbWatchdog({
  probe: () => withDbWatchdogProbe(async (tx) => {
    await tx.unsafe('SELECT 1');
  }, 2_000, Math.max(500, config.DB_WATCHDOG_TIMEOUT_MS - 500)),
  intervalMs: config.DB_WATCHDOG_INTERVAL_MS,
  timeoutMs: config.DB_WATCHDOG_TIMEOUT_MS,
  maxFailures: config.DB_WATCHDOG_FAILURES,
  onFailure: (error, failures, maxFailures) => {
    logger.error(
      { error, failures, maxFailures, pool: dbPoolStats() },
      'Database watchdog probe failed'
    );
  },
  onRecovery: (previousFailures) => {
    logger.info({ previousFailures, pool: dbPoolStats() }, 'Database watchdog recovered');
  },
  onFatal: (error) => {
    logger.fatal(
      { error, pool: dbPoolStats() },
      'Database pool is unrecoverable; exiting so Railway replaces this replica'
    );
    process.exit(1);
  },
});

if (config.NODE_ENV !== 'local' && config.DB_WATCHDOG_ENABLED) {
  dbWatchdog.start();
}

// Read-only-pool write prober (INC-2026-07-29). Deliberately SEPARATE from
// dbWatchdog: the watchdog escalates to process.exit(1), which is the right
// answer for a dead pool but the WRONG answer for a read-only one — every
// replacement replica would dial the same contaminated Supavisor pool and drop
// live matches on the way out. This prober only flips the breaker, so writes
// resume the moment the pool is genuinely writable again.
const writeProbeIntervalMs = Math.max(5_000, config.DB_WATCHDOG_INTERVAL_MS);
let writeProbeInFlight = false;
const writeProbeTimer = setInterval(() => {
  if (writeProbeInFlight) return;
  // Only probe while degraded: a healthy pool is already proven writable by
  // real traffic, and an idle-hour probe would add pointless pool churn.
  if (!readOnlyDbBreaker.snapshot().degraded) return;
  writeProbeInFlight = true;
  void probeDbWritable(2_000)
    .catch((error) => {
      logger.error({ error }, 'Read-only recovery write probe threw unexpectedly');
    })
    .finally(() => {
      writeProbeInFlight = false;
    });
}, writeProbeIntervalMs);
writeProbeTimer.unref?.();

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Received shutdown signal');
  dbWatchdog.stop();
  clearInterval(writeProbeTimer);
  // Stop responder ticks immediately (server.close waits for open connections,
  // during which the interval could still fire) and drain the in-flight tick
  // before the DB pool closes so a mid-tick accept never hits a closing pool.
  const responderStopped = Promise.all([
    stopAiFriendResponder(),
    stopBotChallengeResponder(),
    stopBotRenameWorker(),
  ]).catch((error) => {
    logger.error({ error }, 'Shutdown cleanup step failed');
  });
  io.close();
  server.close(async () => {
    await responderStopped;
    const results = await Promise.allSettled([
      closeRedisClients(),
      shutdownPostHog(),
      shutdownLokiLogStream(),
      shutdownTelemetry(),
      disconnectDb(),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error({ error: result.reason }, 'Shutdown cleanup step failed');
      }
    }
    logger.info('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
