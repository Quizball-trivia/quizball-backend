import { createServer } from 'http';
import { createApp } from './app.js';
import { config } from './core/config.js';
import { logger } from './core/logger.js';
import { shutdownLokiLogStream } from './core/loki.js';
import { shutdownTelemetry } from './core/otel.js';
import { disconnectDb } from './db/index.js';
import { dbPoolStats, withStatementTimeout } from './db/index.js';
import { DbWatchdog } from './db/watchdog.js';
import { initSocketServer } from './realtime/socket-server.js';
import { closeRedisClients } from './realtime/redis.js';
import { shutdownPostHog } from './core/analytics.js';

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

const dbWatchdog = new DbWatchdog({
  probe: () => withStatementTimeout(async (tx) => {
    await tx.unsafe('SELECT 1');
  }, 2_000),
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

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Received shutdown signal');
  dbWatchdog.stop();
  io.close();
  server.close(async () => {
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
