import { randomUUID } from 'crypto';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { getRedisClient } from '../redis.js';
import { acquireLock, releaseLock } from '../locks.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { startDraft, startRankedAiForUser } from './lobby-realtime.service.js';
import {
  RANKED_MM_CANCEL_SEARCH_SCRIPT,
  RANKED_MM_CLAIM_FALLBACK_SCRIPT,
  RANKED_MM_PAIR_TWO_RANDOM_SCRIPT,
} from '../lua/ranked-matchmaking.scripts.js';

const SEARCH_DURATION_MS = 7000;
const SEARCH_KEY_TTL_SEC = 60;
const TICK_INTERVAL_MS = 100;
const TICK_LOCK_TTL_MS = TICK_INTERVAL_MS * 2;
const MAX_FALLBACKS_PER_TICK = 50;
const MAX_PAIRS_PER_TICK = 100;
const FOUND_MODAL_MS = 1200;
const STALE_ACTIVE_MATCH_MS = 15 * 60 * 1000;

const QUEUE_KEY = 'ranked:mm:queue';
const TIMEOUTS_KEY = 'ranked:mm:timeouts';
const USER_MAP_KEY = 'ranked:mm:user';
const SEARCH_KEY_PREFIX = 'ranked:mm:search:';
const TICK_LOCK_KEY = 'ranked:mm:tick-lock';

let loopTimer: NodeJS.Timeout | null = null;
let loopIo: QuizballServer | null = null;

function searchKey(searchId: string): string {
  return `${SEARCH_KEY_PREFIX}${searchId}`;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function isStaleActiveMatch(startedAt: string): boolean {
  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) return false;
  return Date.now() - startedAtMs > STALE_ACTIVE_MATCH_MS;
}

async function emitLobbyState(io: QuizballServer, lobbyId: string): Promise<void> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby) return;
  const state = await lobbiesService.buildLobbyState(lobby);
  io.to(`lobby:${lobbyId}`).emit('lobby:state', state);
}

async function attachUserSocketsToLobby(
  io: QuizballServer,
  userId: string,
  lobbyId: string
): Promise<void> {
  await io.in(`user:${userId}`).socketsJoin(`lobby:${lobbyId}`);
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  sockets.forEach((socket) => {
    socket.data.lobbyId = lobbyId;
  });
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

async function autoLeaveOpenLobby(
  io: QuizballServer,
  lobby: Awaited<ReturnType<typeof lobbiesRepo.listOpenLobbiesForUser>>[number],
  userId: string
): Promise<void> {
  await lobbiesRepo.removeMember(lobby.id, userId);
  await removeUserFromLobbySockets(io, lobby.id, userId);
  logger.info({ lobbyId: lobby.id, userId }, 'Auto-removed user from stale/open lobby before ranked queue join');

  const memberCount = await lobbiesRepo.countMembers(lobby.id);
  if (memberCount === 0) {
    await lobbiesRepo.deleteLobby(lobby.id);
    logger.info({ lobbyId: lobby.id }, 'Lobby deleted after auto-leave before ranked queue join');
    return;
  }

  if (lobby.status === 'waiting' && lobby.host_user_id === userId) {
    await transferHostIfNeeded(lobby.id, userId);
  }

  await emitLobbyState(io, lobby.id);
}

async function startHumanRankedMatch(
  io: QuizballServer,
  userAId: string,
  userBId: string
): Promise<void> {
  if (userAId === userBId) return;

  const [userA, userB] = await Promise.all([
    usersRepo.getById(userAId),
    usersRepo.getById(userBId),
  ]);
  if (!userA || !userB) {
    logger.warn({ userAId, userBId }, 'Ranked pairing skipped: user missing');
    return;
  }

  const lobby = await lobbiesRepo.createLobby({
    mode: 'ranked',
    hostUserId: userAId,
    inviteCode: null,
  });

  await Promise.all([
    lobbiesRepo.addMember(lobby.id, userAId, true),
    lobbiesRepo.addMember(lobby.id, userBId, true),
    attachUserSocketsToLobby(io, userAId, lobby.id),
    attachUserSocketsToLobby(io, userBId, lobby.id),
  ]);

  await emitLobbyState(io, lobby.id);

  io.to(`user:${userAId}`).emit('ranked:match_found', {
    lobbyId: lobby.id,
    opponent: {
      id: userB.id,
      username: userB.nickname ?? 'Player',
      avatarUrl: userB.avatar_url,
    },
  });
  io.to(`user:${userBId}`).emit('ranked:match_found', {
    lobbyId: lobby.id,
    opponent: {
      id: userA.id,
      username: userA.nickname ?? 'Player',
      avatarUrl: userA.avatar_url,
    },
  });

  logger.info({ lobbyId: lobby.id, userAId, userBId }, 'Ranked human match found');

  setTimeout(() => {
    void (async () => {
      const latest = await lobbiesRepo.getById(lobby.id);
      if (!latest || latest.status !== 'waiting' || latest.mode !== 'ranked') return;
      await startDraft(io, lobby.id);
    })();
  }, FOUND_MODAL_MS);
}

async function startAiFallback(io: QuizballServer, userId: string): Promise<void> {
  await startRankedAiForUser(io, userId, { skipSearchEmit: true });
  logger.info({ userId }, 'Ranked matchmaking fallback to AI');
}

async function processFallbacks(io: QuizballServer): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  const now = Date.now();
  const due = await redis.zRangeByScore(TIMEOUTS_KEY, 0, now, {
    LIMIT: { offset: 0, count: MAX_FALLBACKS_PER_TICK },
  });

  for (const searchId of due) {
    const resultRaw = await redis.eval(RANKED_MM_CLAIM_FALLBACK_SCRIPT, {
      keys: [QUEUE_KEY, TIMEOUTS_KEY, USER_MAP_KEY, searchKey(searchId)],
      arguments: [searchId, String(now), String(now)],
    });
    const result = toStringArray(resultRaw);
    const userId = result[0];
    if (!userId) continue;
    await startAiFallback(io, userId);
  }
}

async function processPairs(io: QuizballServer): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  for (let i = 0; i < MAX_PAIRS_PER_TICK; i += 1) {
    const resultRaw = await redis.eval(RANKED_MM_PAIR_TWO_RANDOM_SCRIPT, {
      keys: [QUEUE_KEY, TIMEOUTS_KEY, USER_MAP_KEY],
      arguments: [SEARCH_KEY_PREFIX, String(Date.now())],
    });
    const result = toStringArray(resultRaw);
    if (result.length < 4) return;

    const userAId = result[1];
    const userBId = result[3];
    if (!userAId || !userBId) return;
    await startHumanRankedMatch(io, userAId, userBId);
  }
}

async function rankedTick(): Promise<void> {
  if (!loopIo) return;

  const redis = getRedisClient();
  if (!redis) return;

  const lock = await acquireLock(TICK_LOCK_KEY, TICK_LOCK_TTL_MS);
  if (!lock.acquired || !lock.token) return;

  try {
    await processFallbacks(loopIo);
    await processPairs(loopIo);
  } catch (error) {
    logger.error({ err: error }, 'Ranked matchmaking tick failed');
  } finally {
    await releaseLock(TICK_LOCK_KEY, lock.token);
  }
}

export const rankedMatchmakingService = {
  start(io: QuizballServer): void {
    if (loopTimer || !config.RANKED_HUMAN_QUEUE_ENABLED) return;
    loopIo = io;
    loopTimer = setInterval(() => {
      void rankedTick();
    }, TICK_INTERVAL_MS);
    logger.info('Ranked matchmaking loop started');
  },

  stop(): void {
    if (!loopTimer) return;
    clearInterval(loopTimer);
    loopTimer = null;
    loopIo = null;
    logger.info('Ranked matchmaking loop stopped');
  },

  async handleQueueJoin(
    io: QuizballServer,
    socket: QuizballSocket,
    _payload?: { searchMode?: 'human_first' }
  ): Promise<void> {
    const userId = socket.data.user.id;
    logger.info({ userId }, 'Ranked queue join requested');

    if (!config.RANKED_HUMAN_QUEUE_ENABLED) {
      logger.info({ userId }, 'Ranked human queue disabled, routing to AI');
      await startRankedAiForUser(io, userId);
      return;
    }

    const redis = getRedisClient();
    if (!redis) {
      logger.warn({ userId }, 'Redis unavailable for ranked queue join, falling back to AI');
      await startRankedAiForUser(io, userId);
      return;
    }

    const lockKey = `lock:ranked:mm:join:${userId}`;
    const lock = await acquireLock(lockKey, 2000);
    if (!lock.acquired || !lock.token) {
      logger.warn({ userId }, 'Ranked queue join blocked: user join lock not acquired');
      socket.emit('error', {
        code: 'RANKED_QUEUE_BUSY',
        message: 'Ranked queue is busy, retry in a moment',
      });
      return;
    }

    try {
      const now = Date.now();
      const deadlineAt = now + SEARCH_DURATION_MS;

      const activeMatch = await matchesRepo.getActiveMatchForUser(userId);
      if (activeMatch) {
        if (isStaleActiveMatch(activeMatch.started_at)) {
          logger.warn(
            {
              userId,
              matchId: activeMatch.id,
              startedAt: activeMatch.started_at,
            },
            'Ranked queue join found stale active match, abandoning it'
          );
          await matchesRepo.abandonMatch(activeMatch.id);
        } else {
          logger.warn(
            { userId, matchId: activeMatch.id, startedAt: activeMatch.started_at },
            'Ranked queue join blocked: active match exists'
          );
          socket.emit('error', {
            code: 'RANKED_QUEUE_BLOCKED',
            message: 'You are already in an active match',
            meta: { matchId: activeMatch.id },
          });
          return;
        }
      }

      const openLobbies = await lobbiesRepo.listOpenLobbiesForUser(userId);
      logger.info({ userId, count: openLobbies.length }, 'Ranked queue join open lobbies check');
      for (const lobby of openLobbies) {
        if (lobby.status === 'active') {
          const matchForLobby = await matchesRepo.getActiveMatchForLobby(lobby.id);
          if (matchForLobby) {
            if (isStaleActiveMatch(matchForLobby.started_at)) {
              logger.warn(
                {
                  userId,
                  lobbyId: lobby.id,
                  matchId: matchForLobby.id,
                  startedAt: matchForLobby.started_at,
                },
                'Ranked queue join found stale active lobby match, abandoning it'
              );
              await matchesRepo.abandonMatch(matchForLobby.id);
            } else {
              logger.warn(
                { userId, lobbyId: lobby.id, matchId: matchForLobby.id },
                'Ranked queue join blocked: active lobby match exists'
              );
              socket.emit('error', {
                code: 'RANKED_QUEUE_BLOCKED',
                message: 'Leave your current lobby or match before ranked matchmaking',
                meta: { lobbyId: lobby.id, matchId: matchForLobby.id },
              });
              return;
            }
          }
        }
        await autoLeaveOpenLobby(io, lobby, userId);
      }

      const leftoverLobbies = await lobbiesRepo.listOpenLobbiesForUser(userId);
      if (leftoverLobbies.length > 0) {
        logger.warn(
          { userId, lobbyIds: leftoverLobbies.map((lobby) => lobby.id) },
          'Ranked queue join blocked: failed to clear existing lobby memberships'
        );
        socket.emit('error', {
          code: 'RANKED_QUEUE_BLOCKED',
          message: 'Could not leave previous lobby state, try again',
        });
        return;
      }

      const existingSearchId = await redis.hGet(USER_MAP_KEY, userId);
      if (existingSearchId) {
        const existing = await redis.hGetAll(searchKey(existingSearchId));
        if (existing.status === 'queued') {
          const remainingMs = Math.max(0, Number(existing.deadlineAt ?? String(deadlineAt)) - now);
          logger.info({ userId, searchId: existingSearchId, remainingMs }, 'Ranked queue join resumed existing queue');
          socket.emit('ranked:search_started', { durationMs: remainingMs || SEARCH_DURATION_MS });
          return;
        }
        await redis.hDel(USER_MAP_KEY, userId);
      }

      const newSearchId = randomUUID();
      const multiResult = await redis
        .multi()
        .hSet(searchKey(newSearchId), {
          userId,
          status: 'queued',
          queuedAt: String(now),
          deadlineAt: String(deadlineAt),
        })
        .expire(searchKey(newSearchId), SEARCH_KEY_TTL_SEC)
        .zAdd(QUEUE_KEY, { score: now, value: newSearchId })
        .zAdd(TIMEOUTS_KEY, { score: deadlineAt, value: newSearchId })
        .hSet(USER_MAP_KEY, userId, newSearchId)
        .exec();

      if (!multiResult) {
        logger.error({ userId }, 'Ranked queue join failed: Redis multi returned null');
        socket.emit('error', {
          code: 'RANKED_QUEUE_UNAVAILABLE',
          message: 'Ranked queue is unavailable, please retry',
        });
        return;
      }

      socket.emit('ranked:search_started', { durationMs: SEARCH_DURATION_MS });
      logger.info({ userId, searchId: newSearchId }, 'User joined ranked queue');
    } finally {
      await releaseLock(lockKey, lock.token);
    }
  },

  async handleQueueLeave(socket: QuizballSocket): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;

    const userId = socket.data.user.id;
    const resultRaw = await redis.eval(RANKED_MM_CANCEL_SEARCH_SCRIPT, {
      keys: [QUEUE_KEY, TIMEOUTS_KEY, USER_MAP_KEY],
      arguments: [SEARCH_KEY_PREFIX, userId, String(Date.now())],
    });
    const result = toStringArray(resultRaw);
    if (result.length > 0) {
      logger.info({ userId, searchId: result[0] }, 'User left ranked queue');
    }
    socket.emit('ranked:queue_left');
  },

  async handleSocketDisconnect(socket: QuizballSocket): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;

    const userId = socket.data.user.id;
    await redis.eval(RANKED_MM_CANCEL_SEARCH_SCRIPT, {
      keys: [QUEUE_KEY, TIMEOUTS_KEY, USER_MAP_KEY],
      arguments: [SEARCH_KEY_PREFIX, userId, String(Date.now())],
    });
  },
};
