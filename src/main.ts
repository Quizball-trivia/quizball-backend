import { createServer } from 'http';
import { createApp } from './app.js';
import { config } from './core/config.js';
import { logger } from './core/logger.js';
import { disconnectDb } from './db/index.js';
import { initSocketServer } from './realtime/socket-server.js';

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

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Received shutdown signal');
  io.close();
  server.close(async () => {
    await disconnectDb();
    logger.info('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
