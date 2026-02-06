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
import { registerRankedHandlers } from './handlers/ranked.handler.js';
import type { ClientToServerEvents, ServerToClientEvents } from './socket.types.js';
import { lobbyRealtimeService } from './services/lobby-realtime.service.js';
import { matchRealtimeService } from './services/match-realtime.service.js';
import { rankedMatchmakingService } from './services/ranked-matchmaking.service.js';

export type QuizballSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketAuthData>;
export type QuizballServer = Server<ClientToServerEvents, ServerToClientEvents>;

export async function initSocketServer(httpServer: HttpServer): Promise<QuizballServer> {
  const io: QuizballServer = new Server(httpServer, {
    cors: {
      origin: (config.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
      credentials: true,
    },
    pingTimeout: 20000,   // How long to wait for pong response
    pingInterval: 10000,  // How often to send ping (must be < pingTimeout)
  });

  const { pubClient, subClient } = await initRedisClients();

  pubClient.on('error', (err) => {
    logger.error({ err }, 'Redis pub client error');
  });
  subClient.on('error', (err) => {
    logger.error({ err }, 'Redis sub client error');
  });

  io.adapter(createAdapter(pubClient, subClient));
  rankedMatchmakingService.start(io);

  io.use(socketAuthMiddleware);

  io.on('connection', async (socket: QuizballSocket) => {
    const user = socket.data.user;
    socket.join(`user:${user.id}`);

    logger.info(
      { userId: user.id, socketId: socket.id, transport: socket.conn.transport.name },
      'Socket connected'
    );

    try {
      await lobbyRealtimeService.rejoinWaitingLobbyOnConnect(io, socket);
    } catch (error) {
      logger.warn({ error, userId: user.id }, 'Failed to rejoin waiting lobby on connect');
    }

    try {
      await matchRealtimeService.rejoinActiveMatchOnConnect(io, socket);
    } catch (error) {
      logger.warn({ error, userId: user.id }, 'Failed to rejoin active match on connect');
    }

    if (!socket.data.matchId) {
      try {
        await matchRealtimeService.emitLastMatchResultIfAny(io, socket);
      } catch (error) {
        logger.warn({ error, userId: user.id }, 'Failed to emit last match results on connect');
      }
    }

    registerLobbyHandlers(io, socket);
    registerRankedHandlers(io, socket);
    registerDraftHandlers(io, socket);
    registerMatchHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      logger.info({ userId: user.id, socketId: socket.id, reason }, 'Socket disconnected');
      void lobbyRealtimeService.handleLobbyDisconnect(io, socket);
      void matchRealtimeService.handleMatchDisconnect(io, socket);
      void rankedMatchmakingService.handleSocketDisconnect(socket);
    });
  });

  return io;
}
