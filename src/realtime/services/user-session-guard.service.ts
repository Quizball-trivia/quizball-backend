import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { acquireLock, releaseLock } from '../locks.js';
import { logger } from '../../core/logger.js';
import { getRedisClient } from '../redis.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import type { LobbyWithJoinedAt } from '../../modules/lobbies/lobbies.types.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { rankedAiLobbyKey } from '../ai-ranked.constants.js';
import { RANKED_MM_CANCEL_SEARCH_SCRIPT } from '../lua/ranked-matchmaking.scripts.js';
import type { SessionBlockedPayload, SessionStatePayload } from '../socket.types.js';
import { withSpan } from '../../core/tracing.js';
import { finalizeMatchAsForfeit } from './match-forfeit.service.js';
import { matchDisconnectKey, matchPresenceKey } from '../match-keys.js';
import { rankedAiMatchKey } from '../ai-ranked.constants.js';

const SESSION_LOCK_TTL_MS = 4000;
const LOBBY_LOCK_TTL_MS = 4000;
const SESSION_LOCK_WAIT_MS = 1200;
const SESSION_LOCK_RETRY_INTERVAL_MS = 75;
const RANKED_QUEUE_KEY = 'ranked:mm:queue';
const RANKED_TIMEOUTS_KEY = 'ranked:mm:timeouts';
const RANKED_USER_MAP_KEY = 'ranked:mm:user';
const RANKED_SEARCH_KEY_PREFIX = 'ranked:mm:search:';
const STALE_ACTIVE_MATCH_MS = 5 * 60 * 1000;
const STALE_ACTIVE_MATCH_WITHOUT_SOCKETS_MS = 90 * 1000;

type ResolveContext = {
  activeMatch: Awaited<ReturnType<typeof matchesRepo.getActiveMatchForUser>> | null;
  queueSearchId: string | null;
  waitingLobbies: LobbyWithJoinedAt[];
  activeLobbies: LobbyWithJoinedAt[];
  openLobbies: LobbyWithJoinedAt[];
};

function toSnapshot(context: ResolveContext): SessionStatePayload {
  const indicatorCount =
    Number(Boolean(context.activeMatch?.id)) +
    Number(Boolean(context.queueSearchId)) +
    Number(context.waitingLobbies.length > 0);

  let state: SessionStatePayload['state'] = 'IDLE';
  if (indicatorCount > 1 || context.waitingLobbies.length > 1) {
    state = 'CORRUPT_MULTI_STATE';
  } else if (context.activeMatch?.id) {
    state = 'IN_ACTIVE_MATCH';
  } else if (context.queueSearchId) {
    state = 'IN_QUEUE';
  } else if (context.waitingLobbies.length > 0) {
    state = 'IN_WAITING_LOBBY';
  }

  return {
    state,
    activeMatchId: context.activeMatch?.id ?? null,
    waitingLobbyId: context.waitingLobbies[0]?.id ?? null,
    queueSearchId: context.queueSearchId,
    openLobbyIds: context.openLobbies.map((lobby) => lobby.id),
    resolvedAt: new Date().toISOString(),
  };
}

function isStaleActiveMatch(startedAt: string): boolean {
  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) return false;
  return Date.now() - startedAtMs > STALE_ACTIVE_MATCH_MS;
}

async function resolveContext(userId: string): Promise<ResolveContext> {
  return withSpan('session.resolve_context', {
    'quizball.user_id': userId,
  }, async (span) => {
    const redis = getRedisClient();
    const queueSearchIdPromise = redis
      ? redis.hGet(RANKED_USER_MAP_KEY, userId)
      : Promise.resolve<string | null>(null);

    const [activeMatch, openLobbies, queueSearchId] = await Promise.all([
      matchesRepo.getActiveMatchForUser(userId),
      lobbiesRepo.listOpenLobbiesForUser(userId),
      queueSearchIdPromise,
    ]);

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

async function cleanupStaleOrphanActiveMatch(
  io: QuizballServer,
  userId: string,
  context: ResolveContext
): Promise<void> {
  const activeMatch = context.activeMatch;
  if (!activeMatch) return;

  const startedAtMs = Date.parse(activeMatch.started_at);
  const ageMs = Number.isNaN(startedAtMs) ? 0 : Date.now() - startedAtMs;
  const staleByAge = isStaleActiveMatch(activeMatch.started_at);

  let staleByNoSockets = false;
  if (ageMs >= STALE_ACTIVE_MATCH_WITHOUT_SOCKETS_MS) {
    const sockets = await io.in(`match:${activeMatch.id}`).fetchSockets();
    staleByNoSockets = sockets.length === 0;
  }

  if (!staleByAge && !staleByNoSockets) return;

  if (activeMatch.mode === 'ranked') {
    const players = await matchesRepo.listMatchPlayers(activeMatch.id);
    const finalized = await finalizeMatchAsForfeit({
      matchId: activeMatch.id,
      forfeitingUserId: userId,
      activeMatch,
      cleanupRedisKeys: [
        rankedAiMatchKey(activeMatch.id),
        ...players.flatMap((player) => [
          matchDisconnectKey(activeMatch.id, player.user_id),
          matchPresenceKey(activeMatch.id, player.user_id),
        ]),
      ],
    });

    if (finalized.completed) {
      logger.warn(
        {
          userId,
          matchId: activeMatch.id,
          lobbyId: activeMatch.lobby_id,
          startedAt: activeMatch.started_at,
          staleByAge,
          staleByNoSockets,
        },
        'Session guard finalized stale orphan ranked match as forfeit'
      );
      return;
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
      'Session guard skipped ranked abandon fallback because forfeit finalization did not complete'
    );
    return;
  }

  const abandoned = await matchesRepo.abandonMatch(activeMatch.id);
  if (!abandoned) return;

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

async function emitClosedLobbyState(io: QuizballServer, lobbyId: string): Promise<void> {
  io.to(`lobby:${lobbyId}`).emit('lobby:state', {
    lobbyId,
    mode: 'friendly',
    status: 'closed',
    inviteCode: null,
    displayName: 'Lobby closed',
    isPublic: false,
    hostUserId: '',
    settings: {
      gameMode: 'friendly_possession',
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
    await emitClosedLobbyState(io, lobby.id);
    logger.info({ lobbyId: lobby.id, userId, reason }, 'Session guard removed and deleted empty lobby');
    return;
  }

  if (lobby.status === 'waiting' && lobby.host_user_id === userId) {
    await transferHostIfNeeded(lobby.id, userId);
  }

  await emitLobbyState(io, lobby.id);
  logger.info({ lobbyId: lobby.id, userId, reason }, 'Session guard removed user from lobby');
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
    keepWaitingLobbyId?: string;
    preserveActiveMatchId?: string | null;
  } = {}
): Promise<void> {
  const openLobbies = await lobbiesRepo.listOpenLobbiesForUser(userId);
  for (const lobby of openLobbies) {
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

    if (isStaleActiveMatch(activeMatchForLobby.started_at)) {
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
    }
  ): Promise<boolean> {
    const userId = socket.data.user.id;
    const locked = await this.withUserSessionLock(userId, work, {
      waitMs: SESSION_LOCK_WAIT_MS,
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
    let context = await resolveContext(userId);
    await cleanupStaleOrphanActiveMatch(io, userId, context);
    context = await resolveContext(userId);

    if (context.activeMatch?.id) {
      await cancelRankedQueueSearch(userId);
      await cleanupOpenLobbies(io, userId, {
        preserveActiveMatchId: context.activeMatch.id,
      });
      return this.resolveState(userId);
    }

    const keepWaitingLobbyId = context.waitingLobbies[0]?.id;
    if (context.queueSearchId && keepWaitingLobbyId) {
      await cancelRankedQueueSearch(userId);
    }
    await cleanupOpenLobbies(io, userId, {
      keepWaitingLobbyId,
      preserveActiveMatchId: null,
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
    const snapshot = await this.resolveState(userId);
    if (snapshot.activeMatchId) {
      return {
        ok: false,
        snapshot,
        reason: 'ACTIVE_MATCH',
        message: 'You are already in an active match',
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
};
