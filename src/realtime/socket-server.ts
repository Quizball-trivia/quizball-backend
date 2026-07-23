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
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
} from './socket.types.js';
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
import {
  resolvePartyQuizRound,
  runPartyQuizRoundTransition,
} from './party-quiz-match-flow.js';
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
import {
  postConnectDbTaskLimiter,
  socketDbTaskLimiter,
} from './socket-db-task-limiter.js';
import { ConnectStateBatcher } from './connect-state-batcher.js';
import type { SessionStatePayload } from './socket.types.js';
import { acknowledgeLocalMatchUiReady } from './match-ui-ready-gate.js';
import { socketRuntimeTracker } from './socket-runtime-stats.js';

export type QuizballSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketAuthData
>;
export type QuizballServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketAuthData
>;

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
const connectStateBatcher = new ConnectStateBatcher(
  (userIds) => userSessionGuardService.resolveStates(userIds)
);

function runSocketDbTask(
  operation: string,
  userId: string,
  task: () => Promise<unknown>
): void {
  void socketDbTaskLimiter.run(task).catch((error) => {
    logger.warn({ error, operation, userId }, 'Socket DB task failed');
  });
}

type DisconnectDbTask = 'lobby_disconnect' | 'match_disconnect';

/**
 * Route a disconnect through the state it was actually bound to. A known
 * match socket cannot also need the lobby DB fallback (and vice versa), while
 * an unbound socket still needs both defensive recovery lookups.
 */
function selectDisconnectDbTasks(binding: {
  lobbyId?: string;
  matchId?: string;
}): DisconnectDbTask[] {
  const hasLobby = Boolean(binding.lobbyId);
  const hasMatch = Boolean(binding.matchId);
  if (hasLobby && !hasMatch) return ['lobby_disconnect'];
  if (hasMatch && !hasLobby) return ['match_disconnect'];
  return ['lobby_disconnect', 'match_disconnect'];
}

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
  initialSnapshot: SessionStatePayload,
  attempt = 0
): Promise<void> {
  if (!socket.connected) return;

  const userId = socket.data.user.id;
  let lockAcquired = false;
  let preparedSnapshot: SessionStatePayload | null = null;
  try {
    if (initialSnapshot.state === 'IDLE') {
      // The common path is read-only. Avoid taking the transition lock so an
      // immediate lobby:create/search command cannot race and lose to optional
      // connection hydration.
      preparedSnapshot = initialSnapshot;
      lockAcquired = true;
    } else {
      const lockResult = await userSessionGuardService.withUserSessionLock(
        userId,
        async () => userSessionGuardService.prepareForConnect(io, userId),
        { waitMs: POST_CONNECT_RETRY_MS }
      );
      if (lockResult) preparedSnapshot = lockResult;
      lockAcquired = lockResult !== null;
    }
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
        runLimitedPostConnectHydration(io, socket, attempt + 1);
      }, delayMs);
    } else {
      logger.warn(
        { userId, socketId: socket.id, attempts: attempt + 1 },
        'Post-connect hydration exhausted retries'
      );
    }
    return;
  }

  if (preparedSnapshot?.activeMatchId) {
    try {
      await matchRealtimeService.rejoinActiveMatchOnConnect(io, socket);
    } catch (error) {
      logger.warn({ error, userId }, 'Failed to rejoin active match on connect');
    }
  }

  if (!socket.data.matchId && preparedSnapshot?.waitingLobbyId) {
    try {
      await lobbyRealtimeService.rejoinWaitingLobbyOnConnect(io, socket);
    } catch (error) {
      logger.warn({ error, userId }, 'Failed to rejoin waiting lobby on connect');
    }
  }

  if (!socket.data.matchId && !socket.data.lobbyId && preparedSnapshot?.waitingLobbyId) {
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

  if (preparedSnapshot?.state === 'IDLE') {
    userSessionGuardService.emitSnapshot(io, userId, preparedSnapshot);
  } else {
    try {
      await userSessionGuardService.emitState(io, userId);
    } catch (error) {
      logger.warn({ error, userId }, 'Failed to emit session state on connect');
    }
  }
}

function runLimitedPostConnectHydration(
  io: QuizballServer,
  socket: QuizballSocket,
  attempt = 0
): void {
  void (async () => {
    // Resolve connection state before entering the four-task follow-up limiter.
    // Keeping this lookup inside the limiter prevented the 250-user batcher
    // from ever collecting more than four users during a connection wave.
    const initialSnapshot = await connectStateBatcher.resolve(socket.data.user.id);
    if (!socket.connected) return;
    const hydrate = () =>
      runPostConnectHydration(io, socket, initialSnapshot, attempt);
    if (initialSnapshot.state === 'IDLE') {
      await postConnectDbTaskLimiter.run(hydrate);
    } else {
      await postConnectDbTaskLimiter.runPriority(hydrate);
    }
  })().catch((error) => {
    logger.warn(
      {
        error,
        userId: socket.data.user.id,
        socketId: socket.id,
        attempt,
      },
      'Post-connect hydration task failed'
    );
  });
}

/**
 * The durable realtime-timer handler map. Exported so the regression harness can
 * drive the exact same timer wiring the production server uses (avoids drift
 * between what the harness exercises and what actually runs).
 */
export function buildRealtimeTimerHandlers(): RealtimeTimerHandlers {
  return {
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
    party_round_transition: async (server, payload: RealtimeTimerPayload) => {
      if (payload.kind !== 'party_round_transition') return;
      await runPartyQuizRoundTransition(
        server,
        payload.matchId,
        payload.resolvedQIndex,
        payload.nextQIndex
      );
    },
    possession_ai_answer: async (server, payload: RealtimeTimerPayload) => {
      if (payload.kind !== 'possession_ai_answer') return;
      await runPossessionAiAnswer(
        server,
        payload.matchId,
        payload.qIndex,
        payload.plannedAnswerTimeMs,
        payload.plannedClueIndex,
        payload.plannedIsCorrect
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

  // A match's kickoff gate lives on the replica that started it, while each
  // player's sticky websocket may live on either replica. Forward an ack that
  // misses locally to every peer; only the replica owning the gate consumes it.
  io.on('match:ui_ready_ack', (userId, matchId, phase) => {
    acknowledgeLocalMatchUiReady(io, userId, matchId, phase);
  });

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
    socketRuntimeTracker.connected();
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
      socketRuntimeTracker.disconnected();
      // matchId/lobbyId included so a silent handleMatchDisconnect early-return
      // (socket missing its matchId while a match is live) is diagnosable from
      // logs — observed once on staging (reconnect_smoke 2026-06-10) where a
      // mid-match disconnect produced no pause and no skip.
      logger.debug(
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
      const disconnectDbTasks = selectDisconnectDbTasks(socket.data);
      if (disconnectDbTasks.includes('lobby_disconnect')) {
        runSocketDbTask('lobby_disconnect', user.id, () =>
          lobbyRealtimeService.handleLobbyDisconnect(io, socket)
        );
      }
      if (disconnectDbTasks.includes('match_disconnect')) {
        runSocketDbTask('match_disconnect', user.id, () =>
          matchRealtimeService.handleMatchDisconnect(io, socket)
        );
      }
      void rankedMatchmakingService.handleSocketDisconnect(io, socket);
      void trackUserOffline(io, user.id);
      scheduleOnlineCountBroadcast(io);
    });

    logger.debug(
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
    runLimitedPostConnectHydration(io, socket);
  });

  return io;
}

export const __socketServerInternals = {
  selectDisconnectDbTasks,
};
