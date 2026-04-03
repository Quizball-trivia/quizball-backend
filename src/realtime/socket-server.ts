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
import { registerDevHandlers } from './handlers/dev.handler.js';
import type { ClientToServerEvents, ServerToClientEvents } from './socket.types.js';
import { lobbyRealtimeService } from './services/lobby-realtime.service.js';
import { matchRealtimeService } from './services/match-realtime.service.js';
import { rankedMatchmakingService } from './services/ranked-matchmaking.service.js';
import { warmupRealtimeService } from './services/warmup-realtime.service.js';
import { userSessionGuardService } from './services/user-session-guard.service.js';
import { trackSocketConnected, trackSocketDisconnected } from '../core/analytics/game-events.js';
import { getRedisClient } from './redis.js';

export type QuizballSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketAuthData>;
export type QuizballServer = Server<ClientToServerEvents, ServerToClientEvents>;

const ONLINE_COUNT_KEY = 'presence:online_users';
const ONLINE_COUNT_DEBOUNCE_MS = 250;
const ONLINE_COUNT_REFRESH_MS = 10000;
const POST_CONNECT_RETRY_MS = 350;
const POST_CONNECT_MAX_ATTEMPTS = 6;

let onlineCountDebounceTimer: NodeJS.Timeout | null = null;
let onlineCountRefreshTimer: NodeJS.Timeout | null = null;
let onlineCountInFlight = false;

async function trackUserOnline(userId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.sAdd(ONLINE_COUNT_KEY, userId);
  } catch (error) {
    logger.warn({ error, userId }, 'Failed to track user online in Redis');
  }
}

async function trackUserOffline(io: QuizballServer, userId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    // Only remove if user has no other connected sockets
    const userSockets = await io.in(`user:${userId}`).fetchSockets();
    if (userSockets.length === 0) {
      await redis.sRem(ONLINE_COUNT_KEY, userId);
    }
  } catch (error) {
    logger.warn({ error, userId }, 'Failed to track user offline in Redis');
  }
}

async function getOnlineUserCount(): Promise<number> {
  const redis = getRedisClient();
  if (!redis) return 0;
  try {
    return await redis.sCard(ONLINE_COUNT_KEY);
  } catch (error) {
    logger.warn({ error }, 'Failed to get online user count from Redis');
    return 0;
  }
}

async function emitOnlineCount(io: QuizballServer, socket?: QuizballSocket): Promise<void> {
  if (onlineCountInFlight) return;
  onlineCountInFlight = true;
  try {
    const onlineUsers = await getOnlineUserCount();
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

async function runPostConnectHydration(
  io: QuizballServer,
  socket: QuizballSocket,
  attempt = 0
): Promise<void> {
  if (!socket.connected) return;

  const userId = socket.data.user.id;
  let lockAcquired = false;
  try {
    const lockResult = await userSessionGuardService.withUserSessionLock(
      userId,
      async () => {
        await userSessionGuardService.prepareForConnect(io, userId);
      },
      { waitMs: POST_CONNECT_RETRY_MS }
    );
    lockAcquired = lockResult !== null;
  } catch (error) {
    logger.warn({ error, userId, attempt }, 'Failed to prepare session state on connect');
  }

  if (!lockAcquired) {
    if (attempt === 0) {
      logger.warn({ userId, socketId: socket.id }, 'Session lock busy on connect, scheduling rejoin retry');
      try {
        const snapshot = await userSessionGuardService.resolveState(userId);
        userSessionGuardService.emitBlocked(socket, {
          reason: 'TRANSITION_IN_PROGRESS',
          message: 'Session transition in progress. State will update when ready.',
          operation: 'connect',
          stateSnapshot: snapshot,
        });
      } catch (error) {
        logger.warn({ error, userId }, 'Failed to emit blocked state on connect');
      }
    }

    if (attempt < POST_CONNECT_MAX_ATTEMPTS) {
      const delayMs = POST_CONNECT_RETRY_MS * (attempt + 1);
      setTimeout(() => {
        void runPostConnectHydration(io, socket, attempt + 1);
      }, delayMs);
    } else {
      logger.warn(
        { userId, socketId: socket.id, attempts: attempt + 1 },
        'Post-connect hydration exhausted retries'
      );
    }
    return;
  }

  try {
    await matchRealtimeService.rejoinActiveMatchOnConnect(io, socket);
  } catch (error) {
    logger.warn({ error, userId }, 'Failed to rejoin active match on connect');
  }

  if (!socket.data.matchId) {
    try {
      await lobbyRealtimeService.rejoinWaitingLobbyOnConnect(io, socket);
    } catch (error) {
      logger.warn({ error, userId }, 'Failed to rejoin waiting lobby on connect');
    }
  }

  if (!socket.data.matchId) {
    try {
      await matchRealtimeService.emitLastMatchResultIfAny(io, socket);
    } catch (error) {
      logger.warn({ error, userId }, 'Failed to emit last match results on connect');
    }
  }

  try {
    await userSessionGuardService.emitState(io, userId);
  } catch (error) {
    logger.warn({ error, userId }, 'Failed to emit session state on connect');
  }
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

    // Store connection time for session duration tracking
    const connectedAt = Date.now();
    socket.data.connectedAt = connectedAt;
    trackSocketConnected(user.id);

    // Register handlers immediately so early buffered client events are not dropped.
    registerLobbyHandlers(io, socket);
    registerRankedHandlers(io, socket);
    registerDraftHandlers(io, socket);
    registerMatchHandlers(io, socket);
    registerWarmupHandlers(io, socket);
    registerDevHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      logger.info({ userId: user.id, socketId: socket.id, reason }, 'Socket disconnected');
      // Calculate actual session duration from connection time
      const durationMs = Date.now() - (socket.data.connectedAt ?? connectedAt);
      trackSocketDisconnected(user.id, reason, durationMs);
      warmupRealtimeService.handleSocketDisconnect(socket.id);
      void lobbyRealtimeService.handleLobbyDisconnect(io, socket);
      void matchRealtimeService.handleMatchDisconnect(io, socket);
      void rankedMatchmakingService.handleSocketDisconnect(io, socket);
      void trackUserOffline(io, user.id);
      scheduleOnlineCountBroadcast(io);
    });

    logger.info(
      { userId: user.id, socketId: socket.id, transport: socket.conn.transport.name },
      'Socket connected'
    );
    void trackUserOnline(user.id);
    void emitOnlineCount(io, socket);
    scheduleOnlineCountBroadcast(io);
    void runPostConnectHydration(io, socket);
  });

  return io;
}
