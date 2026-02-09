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
import { registerWarmupHandlers } from './handlers/warmup.handler.js';
import type { ClientToServerEvents, ServerToClientEvents } from './socket.types.js';
import { lobbyRealtimeService } from './services/lobby-realtime.service.js';
import { matchRealtimeService } from './services/match-realtime.service.js';
import { rankedMatchmakingService } from './services/ranked-matchmaking.service.js';
import { warmupRealtimeService } from './services/warmup-realtime.service.js';
import { userSessionGuardService } from './services/user-session-guard.service.js';

export type QuizballSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketAuthData>;
export type QuizballServer = Server<ClientToServerEvents, ServerToClientEvents>;

const ONLINE_COUNT_DEBOUNCE_MS = 250;
const ONLINE_COUNT_REFRESH_MS = 10000;

let onlineCountDebounceTimer: NodeJS.Timeout | null = null;
let onlineCountRefreshTimer: NodeJS.Timeout | null = null;
let onlineCountInFlight = false;

async function computeOnlineUserCount(io: QuizballServer): Promise<number> {
  const sockets = await io.fetchSockets();
  const onlineUsers = new Set<string>();
  for (const socket of sockets) {
    const userId = socket.data.user?.id;
    if (userId) onlineUsers.add(userId);
  }
  return onlineUsers.size;
}

async function emitOnlineCount(io: QuizballServer, socket?: QuizballSocket): Promise<void> {
  if (onlineCountInFlight) return;
  onlineCountInFlight = true;
  try {
    const onlineUsers = await computeOnlineUserCount(io);
    if (socket) {
      socket.emit('presence:online_count', { onlineUsers });
      return;
    }
    io.emit('presence:online_count', { onlineUsers });
  } catch (error) {
    logger.warn({ error }, 'Failed to emit online user count');
  } finally {
    onlineCountInFlight = false;
  }
}

function scheduleOnlineCountBroadcast(io: QuizballServer): void {
  if (onlineCountDebounceTimer) {
    clearTimeout(onlineCountDebounceTimer);
  }
  onlineCountDebounceTimer = setTimeout(() => {
    onlineCountDebounceTimer = null;
    void emitOnlineCount(io);
  }, ONLINE_COUNT_DEBOUNCE_MS);
}

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

  if (onlineCountRefreshTimer) {
    clearInterval(onlineCountRefreshTimer);
  }
  onlineCountRefreshTimer = setInterval(() => {
    void emitOnlineCount(io);
  }, ONLINE_COUNT_REFRESH_MS);
  onlineCountRefreshTimer.unref();

  io.use(socketAuthMiddleware);

  io.on('connection', async (socket: QuizballSocket) => {
    const user = socket.data.user;
    socket.join(`user:${user.id}`);

    // Register handlers immediately so early buffered client events are not dropped.
    registerLobbyHandlers(io, socket);
    registerRankedHandlers(io, socket);
    registerDraftHandlers(io, socket);
    registerMatchHandlers(io, socket);
    registerWarmupHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      logger.info({ userId: user.id, socketId: socket.id, reason }, 'Socket disconnected');
      warmupRealtimeService.handleSocketDisconnect(socket.id);
      void lobbyRealtimeService.handleLobbyDisconnect(io, socket);
      void matchRealtimeService.handleMatchDisconnect(io, socket);
      void rankedMatchmakingService.handleSocketDisconnect(io, socket);
      scheduleOnlineCountBroadcast(io);
    });

    logger.info(
      { userId: user.id, socketId: socket.id, transport: socket.conn.transport.name },
      'Socket connected'
    );
    void emitOnlineCount(io, socket);
    scheduleOnlineCountBroadcast(io);

    let lockAcquired = false;
    try {
      const lockResult = await userSessionGuardService.withUserSessionLock(user.id, async () => {
        await userSessionGuardService.prepareForConnect(io, user.id);
      });
      lockAcquired = lockResult !== null;
    } catch (error) {
      logger.warn({ error, userId: user.id }, 'Failed to prepare session state on connect');
    }

    // If lock wasn't acquired, another transition is in progress - emit blocked state and skip rejoin logic
    if (!lockAcquired) {
      logger.warn({ userId: user.id, socketId: socket.id }, 'Session lock busy on connect, skipping rejoin');
      try {
        const snapshot = await userSessionGuardService.resolveState(user.id);
        userSessionGuardService.emitBlocked(socket, {
          reason: 'TRANSITION_IN_PROGRESS',
          message: 'Session transition in progress. State will update when ready.',
          operation: 'connect',
          stateSnapshot: snapshot,
        });
      } catch (error) {
        logger.warn({ error, userId: user.id }, 'Failed to emit blocked state on connect');
      }
      return;
    }

    try {
      await matchRealtimeService.rejoinActiveMatchOnConnect(io, socket);
    } catch (error) {
      logger.warn({ error, userId: user.id }, 'Failed to rejoin active match on connect');
    }

    if (!socket.data.matchId) {
      try {
        await lobbyRealtimeService.rejoinWaitingLobbyOnConnect(io, socket);
      } catch (error) {
        logger.warn({ error, userId: user.id }, 'Failed to rejoin waiting lobby on connect');
      }
    }

    if (!socket.data.matchId) {
      try {
        await matchRealtimeService.emitLastMatchResultIfAny(io, socket);
      } catch (error) {
        logger.warn({ error, userId: user.id }, 'Failed to emit last match results on connect');
      }
    }

    try {
      await userSessionGuardService.emitState(io, user.id);
    } catch (error) {
      logger.warn({ error, userId: user.id }, 'Failed to emit session state on connect');
    }
  });

  return io;
}
