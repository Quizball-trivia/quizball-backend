import type { Server as HttpServer } from 'http';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { initRedisClients } from './redis.js';
import { socketAuthMiddleware, type SocketAuthData } from './socket-auth.js';
import { registerLobbyHandlers } from './handlers/lobby.handler.js';
import { registerDraftHandlers } from './handlers/draft.handler.js';
import { registerMatchHandlers } from './handlers/match.handler.js';
import type { ClientToServerEvents, ServerToClientEvents } from './socket.types.js';

export type QuizballSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketAuthData>;
export type QuizballServer = Server<ClientToServerEvents, ServerToClientEvents>;

export async function initSocketServer(httpServer: HttpServer): Promise<QuizballServer> {
  const io: QuizballServer = new Server(httpServer, {
    cors: {
      origin: (config.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
      credentials: true,
    },
    pingTimeout: 20000,
    pingInterval: 25000,
  });

  const { pubClient, subClient } = await initRedisClients();
  io.adapter(createAdapter(pubClient, subClient));

  io.use(socketAuthMiddleware);

  io.on('connection', (socket: QuizballSocket) => {
    const user = socket.data.user;
    socket.join(`user:${user.id}`);

    logger.info(
      { userId: user.id, socketId: socket.id, transport: socket.conn.transport.name },
      'Socket connected'
    );

    registerLobbyHandlers(io, socket);
    registerDraftHandlers(io, socket);
    registerMatchHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      logger.info({ userId: user.id, socketId: socket.id, reason }, 'Socket disconnected');
    });
  });

  return io;
}
