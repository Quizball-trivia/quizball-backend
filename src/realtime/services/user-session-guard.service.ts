import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { acquireLock, releaseLock } from '../locks.js';
import { logger } from '../../core/logger.js';
import { getRedisClient } from '../redis.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import type { LobbyWithJoinedAt } from '../../modules/lobbies/lobbies.types.js';
import { matchPlayersRepo } from '../../modules/matches/match-players.repo.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { trackMatchAbandoned } from '../../core/analytics/game-events.js';
import { rankedAiLobbyKey } from '../ai-ranked.constants.js';
import { RANKED_MM_CANCEL_SEARCH_SCRIPT } from '../lua/ranked-matchmaking.scripts.js';
import type { SessionBlockedPayload, SessionStatePayload } from '../socket.types.js';
import { withSpan } from '../../core/tracing.js';
import { finalizeMatchAsForfeit } from './match-forfeit.service.js';
import {
  matchDisconnectKey,
  matchGraceKey,
  matchPauseKey,
  matchPresenceKey,
  matchReconnectCountKey,
  matchResumeCountdownKey,
} from '../match-keys.js';
import { rankedPairingInFlightKey } from '../ranked-matchmaking-keys.js';
import { rankedAiMatchKey } from '../ai-ranked.constants.js';
import { isUserDroppedFromPartyMatch } from '../party-quiz-state.js';
import { completePossessionMatchFromProgress } from '../possession-completion.js';
import {
  buildFinalResultsPayload,
  emitFinalResultsToMatchParticipants,
} from './match-final-results.service.js';
import { resolveMatchPresence } from './match-presence.service.js';
import { abandonMatchWithCompleteLock } from './match-terminal.service.js';
import { resolveMatchReplayEvidence } from './match-entry.service.js';

const SESSION_LOCK_TTL_MS = 4000;
const LOBBY_LOCK_TTL_MS = 4000;
const SESSION_LOCK_WAIT_MS = 1200;
const SESSION_LOCK_RETRY_INTERVAL_MS = 75;
const RANKED_QUEUE_KEY = 'ranked:mm:queue';
const RANKED_TIMEOUTS_KEY = 'ranked:mm:timeouts';
const RANKED_USER_MAP_KEY = 'ranked:mm:user';
const RANKED_SEARCH_KEY_PREFIX = 'ranked:mm:search:';
const STALE_ACTIVE_MATCH_MS = 15 * 60 * 1000;
const STALE_ACTIVE_MATCH_WITHOUT_SOCKETS_MS = 90 * 1000;

type ResolveContext = {
  activeMatch: Awaited<ReturnType<typeof matchesRepo.getActiveMatchForUser>> | null;
  queueSearchId: string | null;
  waitingLobbies: LobbyWithJoinedAt[];
  activeLobbies: LobbyWithJoinedAt[];
  openLobbies: LobbyWithJoinedAt[];
};

function toSnapshot(context: ResolveContext): SessionStatePayload {
  const primaryLobby = context.waitingLobbies[0] ?? context.activeLobbies[0] ?? null;
  const indicatorCount =
    Number(Boolean(context.activeMatch?.id)) +
    Number(Boolean(context.queueSearchId)) +
    Number(Boolean(primaryLobby));

  let state: SessionStatePayload['state'] = 'IDLE';
  if (indicatorCount > 1 || context.waitingLobbies.length + context.activeLobbies.length > 1) {
    state = 'CORRUPT_MULTI_STATE';
  } else if (context.activeMatch?.id) {
    state = 'IN_ACTIVE_MATCH';
  } else if (context.queueSearchId) {
    state = 'IN_QUEUE';
  } else if (primaryLobby) {
    state = 'IN_WAITING_LOBBY';
  }

  return {
    state,
    activeMatchId: context.activeMatch?.id ?? null,
    waitingLobbyId: primaryLobby?.id ?? null,
    queueSearchId: context.queueSearchId,
    openLobbyIds: context.openLobbies.map((lobby) => lobby.id),
    resolvedAt: new Date().toISOString(),
  };
}

function isStaleActiveMatch(activityAt: string | null | undefined): boolean {
  const activityAtMs = Date.parse(activityAt ?? '');
  if (Number.isNaN(activityAtMs)) return false;
  return Date.now() - activityAtMs > STALE_ACTIVE_MATCH_MS;
}

function rankedMatchCleanupKeys(matchId: string, userIds: string[]): string[] {
  return [
    matchPauseKey(matchId),
    matchGraceKey(matchId),
    matchResumeCountdownKey(matchId),
    rankedAiMatchKey(matchId),
    ...userIds.flatMap((playerUserId) => [
      matchDisconnectKey(matchId, playerUserId),
      matchPresenceKey(matchId, playerUserId),
      matchReconnectCountKey(matchId, playerUserId),
    ]),
  ];
}

async function cleanupRankedMatchRedisKeys(matchId: string, userIds: string[]): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  await redis.del(rankedMatchCleanupKeys(matchId, userIds));
}

function getStatePayloadString(
  payload: Record<string, unknown> | null,
  key: string
): string | null {
  const value = payload?.[key];
  return typeof value === 'string' ? value : null;
}

function getStatePayloadRecord(
  payload: Record<string, unknown> | null,
  key: string
): Record<string, unknown> | null {
  const value = payload?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasLiveHalftimeDeadline(payload: Record<string, unknown> | null): boolean {
  if (getStatePayloadString(payload, 'phase') !== 'HALFTIME') return false;
  const halftime = getStatePayloadRecord(payload, 'halftime');
  const deadlineAt = typeof halftime?.deadlineAt === 'string' ? halftime.deadlineAt : null;
  const deadlineMs = Date.parse(deadlineAt ?? '');
  return Number.isFinite(deadlineMs) && deadlineMs > Date.now();
}

async function resolveContext(userId: string): Promise<ResolveContext> {
  return withSpan('session.resolve_context', {
    'quizball.user_id': userId,
  }, async (span) => {
    const redis = getRedisClient();
    const queueSearchIdPromise = redis
      ? redis.hGet(RANKED_USER_MAP_KEY, userId)
      : Promise.resolve<string | null>(null);

    const [rawActiveMatch, openLobbies, queueSearchId] = await Promise.all([
      matchesRepo.getActiveMatchForUser(userId),
      lobbiesRepo.listOpenLobbiesForUser(userId),
      queueSearchIdPromise,
    ]);
    const activeMatch = rawActiveMatch && isUserDroppedFromPartyMatch(rawActiveMatch, userId)
      ? null
      : rawActiveMatch;

    span.setAttribute('quizball.has_active_match', Boolean(activeMatch?.id));
    span.setAttribute('quizball.open_lobby_count', openLobbies.length);
    span.setAttribute('quizball.in_ranked_queue', Boolean(queueSearchId));

    return {
      activeMatch,
      queueSearchId: queueSearchId ?? null,
      waitingLobbies: openLobbies.filter((lobby) => lobby.status === 'waiting'),
      activeLobbies: openLobbies.filter((lobby) => lobby.status === 'active'),
      openLobbies,
    };
  });
}

async function hasRankedPairingInFlight(userId: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return false;
  return (await redis.exists(rankedPairingInFlightKey(userId))) === 1;
}

async function cleanupStaleOrphanActiveMatch(
  io: QuizballServer,
  userId: string,
  context: ResolveContext
): Promise<void> {
  const activeMatch = context.activeMatch;
  if (!activeMatch) return;

  const activityAt = activeMatch.updated_at ?? activeMatch.started_at;
  const activityAtMs = Date.parse(activityAt);
  const ageMs = Number.isNaN(activityAtMs) ? 0 : Date.now() - activityAtMs;
  const staleByAge = isStaleActiveMatch(activityAt);

  let matchSocketCount: number | null = null;
  let staleByNoSockets = false;
  if (ageMs >= STALE_ACTIVE_MATCH_WITHOUT_SOCKETS_MS) {
    const sockets = await io.in(`match:${activeMatch.id}`).fetchSockets();
    matchSocketCount = sockets.length;
    staleByNoSockets = matchSocketCount === 0;
  }

  if (hasLiveHalftimeDeadline(activeMatch.state_payload)) {
    logger.info(
      {
        userId,
        matchId: activeMatch.id,
        lobbyId: activeMatch.lobby_id,
        startedAt: activeMatch.started_at,
        updatedAt: activeMatch.updated_at,
        phase: getStatePayloadString(activeMatch.state_payload, 'phase'),
        staleByAge,
        staleByNoSockets,
      },
      'Session guard skipped stale orphan cleanup during live halftime interlude'
    );
    return;
  }

  if (!staleByAge && !staleByNoSockets) return;

  // `prepareForConnect` runs after the new socket has joined user:<id>, but
  // before it has rejoined match:<id>. During a normal page reload the match
  // room can be temporarily empty, so treating "no match sockets" as orphaned
  // here can incorrectly forfeit the reconnecting player's active match.
  // The bypass is scoped to the staleByNoSockets case only — a truly
  // age-stale match should still be cleaned up regardless of reconnects.
  if (staleByNoSockets && !staleByAge) {
    try {
      const userSockets = await io.in(`user:${userId}`).fetchSockets();
      if (userSockets.length > 0) {
        logger.info(
          {
            userId,
            matchId: activeMatch.id,
            lobbyId: activeMatch.lobby_id,
            startedAt: activeMatch.started_at,
            staleByNoSockets,
            userSocketCount: userSockets.length,
          },
          'Session guard skipped staleByNoSockets cleanup because user is reconnecting'
        );
        return;
      }
    } catch (error) {
      logger.warn({ error, userId, matchId: activeMatch.id }, 'Failed to inspect user sockets for stale match cleanup');
    }
  }

  if (activeMatch.mode === 'ranked') {
    if (!staleByAge) {
      logger.info(
        { userId, matchId: activeMatch.id, staleByAge, staleByNoSockets, matchSocketCount },
        'Session guard skipped ranked orphan cleanup before updated_at stale threshold'
      );
      return;
    }

    let userSocketCount: number | null = null;
    try {
      userSocketCount = (await io.in(`user:${userId}`).fetchSockets()).length;
    } catch (error) {
      logger.warn({ error, userId, matchId: activeMatch.id }, 'Failed to inspect user sockets for ranked stale match audit');
    }

    logger.warn(
      {
        userId,
        matchId: activeMatch.id,
        lobbyId: activeMatch.lobby_id,
        startedAt: activeMatch.started_at,
        updatedAt: activeMatch.updated_at,
        phase: getStatePayloadString(activeMatch.state_payload, 'phase'),
        staleReason: staleByAge && staleByNoSockets
          ? 'age_and_no_sockets'
          : staleByAge
            ? 'age'
            : 'no_sockets',
        staleByAge,
        staleByNoSockets,
        matchSocketCount,
        userSocketCount,
      },
      'Session guard stale orphan ranked match cleanup audit'
    );

    const progressResult = await completePossessionMatchFromProgress(io, activeMatch.id, 'session_guard_orphan');
    if (progressResult.completed) return;
    if (progressResult.reason === 'lock_not_acquired' || progressResult.reason === 'not_active') return;

    const players = await matchPlayersRepo.listMatchPlayers(activeMatch.id);
    const userIds = players.map((player) => player.user_id);
    const presence = await resolveMatchPresence(io, activeMatch.id, players, {
      connectingUserId: userId,
      staleCleanup: true,
    });

    if (presence.absentPlayers.length === 1 && presence.presentPlayers.length > 0) {
      const forfeitingUserId = presence.absentPlayers[0]?.user_id;
      if (!forfeitingUserId) return;
      const finalized = await finalizeMatchAsForfeit({
        matchId: activeMatch.id,
        forfeitingUserId,
        activeMatch,
        cleanupRedisKeys: rankedMatchCleanupKeys(activeMatch.id, userIds),
      });
      if (!finalized.completed) return;
      const finalPayload = await buildFinalResultsPayload(activeMatch.id, finalized.resultVersion);
      if (finalPayload) {
        await emitFinalResultsToMatchParticipants(io, activeMatch.id, finalPayload);
      }
      return;
    }

    const abandoned = await abandonMatchWithCompleteLock(activeMatch.id);
    if (abandoned.abandoned) {
      await cleanupRankedMatchRedisKeys(activeMatch.id, userIds);
      for (const player of players) {
        trackMatchAbandoned(player.user_id, activeMatch.id, activeMatch.mode, 'session_guard_stale_ranked_orphan');
      }
    }
    return;
  }

  const abandoned = await matchesRepo.abandonMatch(activeMatch.id);
  if (!abandoned) return;

  // Analytics: per-participant match_abandoned event.
  try {
    const roster = await matchPlayersRepo.listMatchPlayers(activeMatch.id);
    for (const player of roster) {
      trackMatchAbandoned(player.user_id, activeMatch.id, activeMatch.mode, 'session_guard_stale_orphan');
    }
  } catch (err) {
    logger.warn({ err, matchId: activeMatch.id }, 'match_abandoned analytics failed');
  }

  logger.warn(
    {
      userId,
      matchId: activeMatch.id,
      lobbyId: activeMatch.lobby_id,
      startedAt: activeMatch.started_at,
      staleByAge,
      staleByNoSockets,
    },
    'Session guard abandoned stale orphan active match'
  );
}

async function emitLobbyState(io: QuizballServer, lobbyId: string): Promise<void> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby) return;
  const state = await lobbiesService.buildLobbyState(lobby);
  io.to(`lobby:${lobbyId}`).emit('lobby:state', state);
}

async function removeUserFromLobbySockets(
  io: QuizballServer,
  lobbyId: string,
  userId: string
): Promise<void> {
  const sockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
  sockets.forEach((socket) => {
    if (socket.data.user.id !== userId) return;
    socket.leave(`lobby:${lobbyId}`);
    socket.data.lobbyId = undefined;
  });
}

async function transferHostIfNeeded(lobbyId: string, previousHostId: string): Promise<void> {
  const members = await lobbiesRepo.listMembersWithUser(lobbyId);
  if (members.length === 0) return;
  const nextHostId = members[0]?.user_id;
  if (nextHostId && nextHostId !== previousHostId) {
    await lobbiesRepo.setHostUser(lobbyId, nextHostId);
  }
}

async function emitClosedLobbyState(
  io: QuizballServer,
  lobbyId: string,
  mode: 'friendly' | 'ranked' = 'friendly'
): Promise<void> {
  io.to(`lobby:${lobbyId}`).emit('lobby:state', {
    lobbyId,
    mode,
    status: 'closed',
    inviteCode: null,
    displayName: 'Lobby closed',
    isPublic: false,
    hostUserId: '',
    settings: {
      gameMode: mode === 'ranked' ? 'ranked_sim' : 'friendly_possession',
      friendlyRandom: true,
      friendlyCategoryAId: null,
      friendlyCategoryBId: null,
    },
    members: [],
  });
}

async function removeUserFromLobby(
  io: QuizballServer,
  lobby: LobbyWithJoinedAt,
  userId: string,
  reason: string
): Promise<void> {
  await lobbiesRepo.removeMember(lobby.id, userId);
  await removeUserFromLobbySockets(io, lobby.id, userId);

  if (lobby.mode === 'ranked') {
    const redis = getRedisClient();
    const aiUserId = redis ? await redis.get(rankedAiLobbyKey(lobby.id)) : null;
    if (aiUserId) {
      await lobbiesRepo.removeMember(lobby.id, aiUserId);
      await removeUserFromLobbySockets(io, lobby.id, aiUserId);
      if (redis) {
        await redis.del(rankedAiLobbyKey(lobby.id));
      }
    }
  }

  const memberCount = await lobbiesRepo.countMembers(lobby.id);
  if (memberCount === 0) {
    await lobbiesRepo.deleteLobby(lobby.id);
    await emitClosedLobbyState(io, lobby.id, lobby.mode);
    logger.info({ lobbyId: lobby.id, userId, reason }, 'Session guard removed and deleted empty lobby');
    return;
  }

  if (lobby.status === 'waiting' && lobby.host_user_id === userId) {
    await transferHostIfNeeded(lobby.id, userId);
  }

  await emitLobbyState(io, lobby.id);
  logger.info({ lobbyId: lobby.id, userId, reason }, 'Session guard removed user from lobby');
}

async function closeRankedPreMatchLobby(
  io: QuizballServer,
  lobby: LobbyWithJoinedAt,
  userId: string,
  reason: string
): Promise<void> {
  const members = await lobbiesRepo.listMembersWithUser(lobby.id);
  await lobbiesRepo.deleteLobby(lobby.id);
  const redis = getRedisClient();
  if (redis?.isOpen) {
    await redis.del(rankedAiLobbyKey(lobby.id));
  }

  await emitClosedLobbyState(io, lobby.id, lobby.mode);

  const lobbySockets = await io.in(`lobby:${lobby.id}`).fetchSockets();
  lobbySockets.forEach((socket) => {
    socket.leave(`lobby:${lobby.id}`);
    if (socket.data.lobbyId === lobby.id) {
      socket.data.lobbyId = undefined;
    }
  });

  for (const member of members) {
    io.to(`user:${member.user_id}`).emit('ranked:queue_left');
    const snapshot = toSnapshot(await resolveContext(member.user_id));
    io.to(`user:${member.user_id}`).emit('session:state', snapshot);
  }
  logger.info(
    { lobbyId: lobby.id, userId, reason, memberUserIds: members.map((member) => member.user_id) },
    'Session guard closed ranked pre-match lobby'
  );
}

async function hasAnyHumanEnteredMatch(lobbyId: string, matchId: string): Promise<boolean> {
  const members = await lobbiesRepo.listMembersWithUser(lobbyId);
  const humanUserIds = members
    .filter((member) => !member.is_ai)
    .map((member) => member.user_id);
  if (humanUserIds.length === 0) return false;

  const evidence = await Promise.all(
    humanUserIds.map((memberUserId) => resolveMatchReplayEvidence(matchId, memberUserId))
  );
  return evidence.some((entry) => entry.allowed);
}

async function cancelRankedQueueSearch(userId: string): Promise<void> {
  await withSpan('ranked.queue_cancel', {
    'quizball.user_id': userId,
  }, async (span) => {
    const redis = getRedisClient();
    if (!redis) {
      span.setAttribute('quizball.redis_available', false);
      return;
    }

    span.setAttribute('quizball.redis_available', true);
    await redis.eval(RANKED_MM_CANCEL_SEARCH_SCRIPT, {
      keys: [RANKED_QUEUE_KEY, RANKED_TIMEOUTS_KEY, RANKED_USER_MAP_KEY],
      arguments: [RANKED_SEARCH_KEY_PREFIX, userId, String(Date.now())],
    });
  });
}

async function cleanupOpenLobbies(
  io: QuizballServer,
  userId: string,
  options: {
    keepLobbyId?: string;
    keepWaitingLobbyId?: string;
    preserveActiveMatchId?: string | null;
    cleanupStartedAtMs?: number;
  } = {}
): Promise<void> {
  const openLobbies = await lobbiesRepo.listOpenLobbiesForUser(userId);
  for (const lobby of openLobbies) {
    const joinedAtMs = Date.parse(lobby.joined_at);
    if (
      typeof options.cleanupStartedAtMs === 'number' &&
      Number.isFinite(joinedAtMs) &&
      joinedAtMs > options.cleanupStartedAtMs
    ) {
      logger.info(
        {
          userId,
          lobbyId: lobby.id,
          joinedAt: lobby.joined_at,
          cleanupStartedAt: new Date(options.cleanupStartedAtMs).toISOString(),
        },
        'Session guard skipped lobby cleanup for membership joined after cleanup started'
      );
      continue;
    }

    if (options.keepLobbyId && lobby.id === options.keepLobbyId) {
      continue;
    }

    if (lobby.status === 'waiting') {
      if (options.keepWaitingLobbyId && lobby.id === options.keepWaitingLobbyId) {
        continue;
      }
      await removeUserFromLobby(io, lobby, userId, 'cleanup_waiting');
      continue;
    }

    const activeMatchForLobby = await matchesRepo.getActiveMatchForLobby(lobby.id);
    if (!activeMatchForLobby) {
      await removeUserFromLobby(io, lobby, userId, 'cleanup_stale_active_lobby');
      continue;
    }

    if (options.preserveActiveMatchId && activeMatchForLobby.id === options.preserveActiveMatchId) {
      continue;
    }

    if (isStaleActiveMatch(activeMatchForLobby.updated_at ?? activeMatchForLobby.started_at)) {
      logger.warn(
        {
          userId,
          lobbyId: lobby.id,
          matchId: activeMatchForLobby.id,
          startedAt: activeMatchForLobby.started_at,
        },
        'Session guard found stale active match for lobby'
      );
      continue;
    }

    await removeUserFromLobby(io, lobby, userId, 'cleanup_unrelated_active_lobby');
  }
}

async function cleanupRankedWaitingLobbies(io: QuizballServer, userId: string): Promise<void> {
  const openLobbies = await lobbiesRepo.listOpenLobbiesForUser(userId);
  for (const lobby of openLobbies) {
    if (lobby.mode !== 'ranked') continue;
    if (lobby.status === 'waiting') {
      await removeUserFromLobby(io, lobby, userId, 'ranked_queue_leave');
      continue;
    }

    if (lobby.status !== 'active') continue;
    const activeMatchForLobby = await matchesRepo.getActiveMatchForLobby(lobby.id);
    if (!activeMatchForLobby) {
      await closeRankedPreMatchLobby(io, lobby, userId, 'ranked_queue_leave_active_lobby_no_match');
      continue;
    }

    if (await hasAnyHumanEnteredMatch(lobby.id, activeMatchForLobby.id)) {
      logger.info(
        { userId, lobbyId: lobby.id, matchId: activeMatchForLobby.id },
        'Session guard skipped active ranked lobby cleanup because match has entered evidence'
      );
      continue;
    }

    const players = await matchPlayersRepo.listMatchPlayers(activeMatchForLobby.id);
    const abandoned = await abandonMatchWithCompleteLock(activeMatchForLobby.id);
    if (!abandoned.abandoned) {
      logger.warn(
        { userId, lobbyId: lobby.id, matchId: activeMatchForLobby.id, reason: abandoned.reason },
        'Session guard could not abandon pre-match ranked match during queue leave'
      );
      continue;
    }
    await cleanupRankedMatchRedisKeys(
      activeMatchForLobby.id,
      players.map((player) => player.user_id)
    );
    await closeRankedPreMatchLobby(io, lobby, userId, 'ranked_queue_leave_active_lobby_no_entered_match');
  }
}

export const userSessionGuardService = {
  async withUserSessionLock<T>(
    userId: string,
    work: () => Promise<T>,
    options?: { waitMs?: number }
  ): Promise<T | null> {
    return withSpan('session.user_lock', {
      'quizball.user_id': userId,
    }, async (span) => {
      const lockKey = `lock:user:session:${userId}`;
      const waitMs = Math.max(0, options?.waitMs ?? 0);
      const deadlineMs = Date.now() + waitMs;
      span.setAttribute('quizball.wait_ms', waitMs);

      while (true) {
        const lock = await acquireLock(lockKey, SESSION_LOCK_TTL_MS);
        if (lock.acquired && lock.token) {
          span.setAttribute('quizball.lock_acquired', true);
          try {
            return await work();
          } finally {
            await releaseLock(lockKey, lock.token);
          }
        }

        if (Date.now() >= deadlineMs) {
          span.setAttribute('quizball.lock_acquired', false);
          return null;
        }

        const remainingMs = deadlineMs - Date.now();
        const sleepMs = Math.min(SESSION_LOCK_RETRY_INTERVAL_MS, remainingMs);
        if (sleepMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, sleepMs));
        }
      }
    });
  },

  async withUserAndLobbyLock<T>(
    userId: string,
    lobbyId: string,
    work: () => Promise<T>
  ): Promise<T | null> {
    const userLockKey = `lock:user:session:${userId}`;
    const lobbyLockKey = `lock:lobby:${lobbyId}`;

    const userLock = await acquireLock(userLockKey, SESSION_LOCK_TTL_MS);
    if (!userLock.acquired || !userLock.token) {
      return null;
    }

    const lobbyLock = await acquireLock(lobbyLockKey, LOBBY_LOCK_TTL_MS);
    if (!lobbyLock.acquired || !lobbyLock.token) {
      await releaseLock(userLockKey, userLock.token);
      return null;
    }

    try {
      return await work();
    } finally {
      await releaseLock(lobbyLockKey, lobbyLock.token);
      await releaseLock(userLockKey, userLock.token);
    }
  },

  async resolveState(userId: string): Promise<SessionStatePayload> {
    const context = await resolveContext(userId);
    return toSnapshot(context);
  },

  async emitState(io: QuizballServer, userId: string): Promise<SessionStatePayload> {
    const snapshot = await this.resolveState(userId);
    io.to(`user:${userId}`).emit('session:state', snapshot);
    return snapshot;
  },

  emitBlocked(
    socket: QuizballSocket,
    payload: Omit<SessionBlockedPayload, 'stateSnapshot'> & { stateSnapshot: SessionStatePayload }
  ): void {
    socket.emit('session:blocked', payload);
  },

  async runWithUserTransitionLock(
    _io: QuizballServer,
    socket: QuizballSocket,
    work: () => Promise<void>,
    options?: {
      code?: string;
      message?: string;
      operation?: string;
      waitMs?: number;
    }
  ): Promise<boolean> {
    const userId = socket.data.user.id;
    const locked = await this.withUserSessionLock(userId, work, {
      waitMs: options?.waitMs ?? SESSION_LOCK_WAIT_MS,
    });
    if (locked !== null) {
      return true;
    }

    const snapshot = await this.resolveState(userId);
    logger.warn(
      {
        userId,
        operation: options?.operation ?? null,
        state: snapshot.state,
        activeMatchId: snapshot.activeMatchId,
        waitingLobbyId: snapshot.waitingLobbyId,
        queueSearchId: snapshot.queueSearchId,
      },
      'User transition lock blocked operation'
    );
    this.emitBlocked(socket, {
      reason: 'TRANSITION_IN_PROGRESS',
      message: options?.message ?? 'State transition is in progress. Please retry.',
      operation: options?.operation,
      stateSnapshot: snapshot,
    });
    return false;
  },

  async prepareForConnect(io: QuizballServer, userId: string): Promise<SessionStatePayload> {
    const cleanupStartedAtMs = Date.now();
    let context = await resolveContext(userId);
    await cleanupStaleOrphanActiveMatch(io, userId, context);
    context = await resolveContext(userId);

    if (context.activeMatch?.id) {
      await cancelRankedQueueSearch(userId);
      await cleanupOpenLobbies(io, userId, {
        preserveActiveMatchId: context.activeMatch.id,
        cleanupStartedAtMs,
      });
      return this.resolveState(userId);
    }

    const keepLobbyId = context.waitingLobbies[0]?.id ?? context.activeLobbies[0]?.id;
    if (context.queueSearchId && keepLobbyId) {
      await cancelRankedQueueSearch(userId);
    }
    await cleanupOpenLobbies(io, userId, {
      keepLobbyId,
      keepWaitingLobbyId: context.waitingLobbies[0]?.id,
      preserveActiveMatchId: null,
      cleanupStartedAtMs,
    });
    return this.resolveState(userId);
  },

  async prepareForLobbyEntry(
    io: QuizballServer,
    userId: string,
    options?: {
      keepWaitingLobbyId?: string;
    }
  ): Promise<{ ok: boolean; snapshot: SessionStatePayload; reason?: SessionBlockedPayload['reason']; message?: string }> {
    await this.prepareForConnect(io, userId);
    const snapshot = await this.resolveState(userId);

    if (snapshot.activeMatchId) {
      return {
        ok: false,
        snapshot,
        reason: 'ACTIVE_MATCH',
        message: 'You are already in an active match',
      };
    }

    await cancelRankedQueueSearch(userId);
    await cleanupOpenLobbies(io, userId, {
      keepWaitingLobbyId: options?.keepWaitingLobbyId,
    });
    const nextSnapshot = await this.resolveState(userId);
    return { ok: true, snapshot: nextSnapshot };
  },

  async prepareForQueueJoin(
    io: QuizballServer,
    userId: string
  ): Promise<{ ok: boolean; snapshot: SessionStatePayload; reason?: SessionBlockedPayload['reason']; message?: string }> {
    await this.prepareForConnect(io, userId);
    const context = await resolveContext(userId);
    const snapshot = toSnapshot(context);
    if (await hasRankedPairingInFlight(userId)) {
      return {
        ok: false,
        snapshot,
        reason: 'ACTIVE_MATCH',
        message: 'Your ranked match is starting',
      };
    }

    if (snapshot.activeMatchId) {
      return {
        ok: false,
        snapshot,
        reason: 'ACTIVE_MATCH',
        message: 'You are already in an active match',
      };
    }

    if (context.activeLobbies.length > 0) {
      return {
        ok: false,
        snapshot,
        reason: 'ACTIVE_MATCH',
        message: 'You are already in an active draft',
      };
    }

    if (snapshot.state === 'IN_QUEUE') {
      return { ok: true, snapshot };
    }

    await cancelRankedQueueSearch(userId);
    await cleanupOpenLobbies(io, userId);
    const nextSnapshot = await this.resolveState(userId);
    return { ok: true, snapshot: nextSnapshot };
  },

  async cleanupRankedQueueArtifacts(io: QuizballServer, userId: string): Promise<SessionStatePayload> {
    await cancelRankedQueueSearch(userId);
    await cleanupRankedWaitingLobbies(io, userId);
    return this.resolveState(userId);
  },
};
