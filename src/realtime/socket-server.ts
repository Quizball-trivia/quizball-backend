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
import { registerAuctionHandlers } from './handlers/auction.handler.js';
import type { ClientToServerEvents, ServerToClientEvents } from './socket.types.js';
import { lobbyRealtimeService } from './services/lobby-realtime.service.js';
import { matchRealtimeService } from './services/match-realtime.service.js';
import { rankedMatchmakingService } from './services/ranked-matchmaking.service.js';
import { warmupRealtimeService } from './services/warmup-realtime.service.js';
import { userSessionGuardService } from './services/user-session-guard.service.js';
import { setAuthRealtimeServer } from './services/auth-realtime.service.js';
import { setNotificationsRealtimeServer } from './services/notifications-realtime.service.js';
import { trackSocketConnected, trackSocketDisconnected } from '../core/analytics/game-events.js';
import { getRedisClient } from './redis.js';
import { setUserPingMs } from './user-ping.js';
import { acquireLock, releaseLock } from './locks.js';
import { resolvePartyQuizRound } from './party-quiz-match-flow.js';
import { finalizeHalftime, resolvePossessionRound, runPossessionAiAnswer } from './possession-match-flow.js';
import {
  startRealtimeTimerScheduler,
  type RealtimeTimerPayload,
  type RealtimeTimerHandlers,
} from './realtime-timer-scheduler.js';
import { startStaleMatchSweeper } from './services/stale-match-sweeper.service.js';
import { scheduleBootMatchTimerRearm } from './services/boot-timer-rearm.service.js';
import { completeResumeCountdown, resolveExpiredGraceWindow } from './services/match-disconnect.service.js';
import { runRankedDraftStart } from './services/ranked-matchmaking.service.js';
import {
  runDraftAutoBan,
  runDraftGraceExpiry,
  runRankedAiDraftBan,
} from './services/draft-realtime.service.js';
import {
  recordMatchStagePresenceHeartbeat,
  recordMatchStageReady,
} from './services/match-stage-presence.service.js';
import { rankedDebug, rankedDebugUser } from './ranked-debug.js';
import { runAuctionBotActionTimer } from './services/auction-bot.service.js';
import { runAuctionClueRevealTimer } from './services/auction-clue-timer.service.js';
import { runAuctionTurnTimeoutTimer } from './services/auction-turn.service.js';

export type QuizballSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketAuthData>;
export type QuizballServer = Server<ClientToServerEvents, ServerToClientEvents>;

const ONLINE_COUNT_KEY = 'presence:online_users';
const PRESENCE_LOCK_TTL_MS = 3000;
const ONLINE_COUNT_DEBOUNCE_MS = 250;
const ONLINE_COUNT_REFRESH_MS = 10000;
const POST_CONNECT_RETRY_MS = 150;
const POST_CONNECT_MAX_ATTEMPTS = 10;
// pingTimeout sizing: the previous 3s timeout declared a socket dead after any
// ~5s network hiccup — mobile radio wake-ups, wifi roaming and GC pauses
// routinely take 3-8s, so production saw constant false disconnects (mass
// socket-drop bursts pausing 7+ matches at once, diagnosed 2026-06-10).
// 10s absorbs those; worst-case disconnect detection becomes
// pingInterval + pingTimeout = 12.5s, which the 30s grace flow comfortably
// covers. Intentional exits stay instant (the client emits match:leave).
export const SOCKET_HEARTBEAT_CONFIG = {
  pingInterval: 2500,
  pingTimeout: 10000,
} as const;

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

  const lockKey = `presence:user:${userId}`;
  let lockResult;
  try {
    lockResult = await acquireLock(lockKey, PRESENCE_LOCK_TTL_MS);
  } catch (error) {
    logger.warn({ error, userId }, 'Failed to acquire presence lock');
    return;
  }

  if (!lockResult.acquired) return;

  try {
    // Only remove if user has no other connected sockets
    const userSockets = await io.in(`user:${userId}`).fetchSockets();
    if (userSockets.length === 0) {
      await redis.sRem(ONLINE_COUNT_KEY, userId);
    }
  } catch (error) {
    logger.warn({ error, userId }, 'Failed to track user offline in Redis');
  } finally {
    await releaseLock(lockKey, lockResult.token!).catch(() => {});
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
        await matchRealtimeService.emitPendingForfeitIfAny(socket);
        await matchRealtimeService.emitPendingPartyDropoutIfAny(socket);
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

  if (!socket.data.matchId && !socket.data.lobbyId) {
    try {
      await lobbyRealtimeService.rejoinActiveDraftLobbyOnConnect(io, socket);
    } catch (error) {
      logger.warn({ error, userId }, 'Failed to rejoin active draft lobby on connect');
    }
  }

  if (!socket.data.matchId) {
    try {
      await lobbyRealtimeService.emitPendingChallengeInvitesOnConnect(socket);
    } catch (error) {
      logger.warn({ error, userId }, 'Failed to emit pending challenge invites on connect');
    }
  }

  if (!socket.data.matchId) {
    try {
      await matchRealtimeService.emitPendingForfeitIfAny(socket);
      await matchRealtimeService.emitPendingPartyDropoutIfAny(socket);
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

/**
 * The durable realtime-timer handler map. Exported so the regression harness can
 * drive the exact same timer wiring the production server uses (avoids drift
 * between what the harness exercises and what actually runs).
 */
export function buildRealtimeTimerHandlers(): RealtimeTimerHandlers {
  return {
    auction_bot_action: async (server, payload: RealtimeTimerPayload) => {
      if (payload.kind !== 'auction_bot_action') return;
      await runAuctionBotActionTimer(server, payload);
    },
    auction_clue_reveal: async (server, payload: RealtimeTimerPayload) => {
      if (payload.kind !== 'auction_clue_reveal') return;
      await runAuctionClueRevealTimer(server, payload);
    },
    auction_turn_timeout: async (server, payload: RealtimeTimerPayload) => {
      if (payload.kind !== 'auction_turn_timeout') return;
      await runAuctionTurnTimeoutTimer(server, payload);
    },
    draft_ai_ban: async (server, payload: RealtimeTimerPayload) => {
      if (payload.kind !== 'draft_ai_ban') return;
      await runRankedAiDraftBan(server, payload.lobbyId, payload.aiUserId);
    },
    draft_auto_ban: async (server, payload: RealtimeTimerPayload) => {
      if (payload.kind !== 'draft_auto_ban') return;
      await runDraftAutoBan(server, payload.lobbyId, {
        requireUiReady: payload.requireUiReady,
        forceAtMs: payload.forceAtMs,
      });
    },
    draft_grace_expiry: async (server, payload: RealtimeTimerPayload) => {
      if (payload.kind !== 'draft_grace_expiry') return;
      await runDraftGraceExpiry(server, payload.lobbyId, payload.disconnectedUserId);
    },
    party_question: async (server, payload: RealtimeTimerPayload) => {
      if (payload.kind !== 'party_question') return;
      await resolvePartyQuizRound(server, payload.matchId, payload.qIndex, true);
    },
    possession_ai_answer: async (server, payload: RealtimeTimerPayload) => {
      if (payload.kind !== 'possession_ai_answer') return;
      await runPossessionAiAnswer(
        server,
        payload.matchId,
        payload.qIndex,
        payload.plannedAnswerTimeMs,
        payload.plannedClueIndex
      );
    },
    possession_halftime: async (server, payload: RealtimeTimerPayload) => {
      if (payload.kind !== 'possession_halftime') return;
      await finalizeHalftime(server, payload.matchId);
    },
    possession_question: async (server, payload: RealtimeTimerPayload) => {
      if (payload.kind !== 'possession_question') return;
      await resolvePossessionRound(server, payload.matchId, payload.qIndex, true);
    },
    match_disconnect_forfeit: async (server, payload: RealtimeTimerPayload) => {
      if (payload.kind !== 'match_disconnect_forfeit') return;
      await resolveExpiredGraceWindow(server, payload.matchId, payload.disconnectedUserId);
    },
    match_resume_countdown: async (server, payload: RealtimeTimerPayload) => {
      if (payload.kind !== 'match_resume_countdown') return;
      await completeResumeCountdown(server, payload.matchId, payload.pauseStartedAtMs);
    },
    ranked_draft_start: async (server, payload: RealtimeTimerPayload) => {
      if (payload.kind !== 'ranked_draft_start') return;
      await runRankedDraftStart(server, payload.lobbyId, payload.userAId, payload.userBId);
    },
  };
}

export async function initSocketServer(httpServer: HttpServer): Promise<QuizballServer> {
  const io: QuizballServer = new Server(httpServer, {
    cors: {
      origin: (config.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
      credentials: true,
    },
    // Balance: disconnect feedback within ~12.5s worst case (opponent then
    // sees the grace overlay) vs. NOT killing sockets on routine mobile
    // network hiccups — see SOCKET_HEARTBEAT_CONFIG for the sizing rationale.
    pingInterval: SOCKET_HEARTBEAT_CONFIG.pingInterval,
    pingTimeout: SOCKET_HEARTBEAT_CONFIG.pingTimeout,
  });

  const { pubClient, subClient } = await initRedisClients();

  pubClient.on('error', (err) => {
    logger.error({ err }, 'Redis pub client error');
  });
  subClient.on('error', (err) => {
    logger.error({ err }, 'Redis sub client error');
  });

  io.adapter(createAdapter(pubClient, subClient));

  // Lets services force-disconnect a user's sockets without importing socket-server
  // (which would create a cycle through socket-auth → users.service).
  setAuthRealtimeServer(io);
  // Lets the notifications service push to a user's room without importing socket-server.
  setNotificationsRealtimeServer(io);

  startRealtimeTimerScheduler(io, buildRealtimeTimerHandlers());

  startStaleMatchSweeper(io);

  // A deploy can land inside an in-process round-transition window (ready-ack
  // gates, inter-question delay) — re-arm timers for every active match so no
  // match silently freezes until the 15-minute sweeper.
  scheduleBootMatchTimerRearm(io);

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
    registerAuctionHandlers(io, socket);
    registerDevHandlers(io, socket);

    socket.on('connection:ping', (payload, ack) => {
      ack?.({
        sentAt: Number(payload?.sentAt ?? Date.now()),
        serverNow: new Date().toISOString(),
      });
    });

    socket.on('connection:rtt', (payload) => {
      const rttMs = Number(payload?.rttMs);
      if (!Number.isFinite(rttMs)) return;
      // Best-effort: never let a ping report break the socket pipeline.
      void setUserPingMs(user.id, rttMs).catch((error) => {
        logger.warn({ error, userId: user.id }, 'Failed to store user RTT');
      });
    });

    socket.on('match:presence_heartbeat', (payload) => {
      const matchId = typeof payload?.matchId === 'string' ? payload.matchId : '';
      const stageKey = typeof payload?.stageKey === 'string' ? payload.stageKey : '';
      if (!matchId || !socket.rooms.has(`match:${matchId}`)) return;
      void recordMatchStagePresenceHeartbeat({ matchId, stageKey, userId: user.id, socketId: socket.id }).catch((error) => {
        logger.warn({ error, matchId, stageKey, userId: user.id }, 'Failed to record match stage heartbeat');
      });
    });

    socket.on('match:stage_ready', (payload) => {
      const matchId = typeof payload?.matchId === 'string' ? payload.matchId : '';
      const stageKey = typeof payload?.stageKey === 'string' ? payload.stageKey : '';
      if (!matchId || !socket.rooms.has(`match:${matchId}`)) return;
      void recordMatchStageReady({ matchId, stageKey, userId: user.id }).catch((error) => {
        logger.warn({ error, matchId, stageKey, userId: user.id }, 'Failed to record match stage ready');
      });
    });

    socket.on('disconnect', (reason) => {
      // matchId/lobbyId included so a silent handleMatchDisconnect early-return
      // (socket missing its matchId while a match is live) is diagnosable from
      // logs — observed once on staging (reconnect_smoke 2026-06-10) where a
      // mid-match disconnect produced no pause and no skip.
      logger.info(
        {
          userId: user.id,
          socketId: socket.id,
          reason,
          matchId: socket.data.matchId ?? null,
          lobbyId: socket.data.lobbyId ?? null,
        },
        'Socket disconnected'
      );
      rankedDebug('socket_disconnected', {
        user: rankedDebugUser(user.id),
        socket: socket.id,
        reason,
      });
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
    rankedDebug('socket_connected', {
      user: rankedDebugUser(user.id),
      socket: socket.id,
      transport: socket.conn.transport.name,
    });
    void trackUserOnline(user.id);
    void emitOnlineCount(io, socket);
    scheduleOnlineCountBroadcast(io);
    void runPostConnectHydration(io, socket);
  });

  return io;
}
