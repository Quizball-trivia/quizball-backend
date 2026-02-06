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
const TICK_LOCK_TTL_MS = 90;
const MAX_FALLBACKS_PER_TICK = 50;
const MAX_PAIRS_PER_TICK = 100;
const FOUND_MODAL_MS = 1200;

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

    if (!config.RANKED_HUMAN_QUEUE_ENABLED) {
      await startRankedAiForUser(io, userId);
      return;
    }

    const redis = getRedisClient();
    if (!redis) {
      socket.emit('error', {
        code: 'RANKED_QUEUE_UNAVAILABLE',
        message: 'Ranked queue is temporarily unavailable',
      });
      return;
    }

    const [activeMatch, openLobbies] = await Promise.all([
      matchesRepo.getActiveMatchForUser(userId),
      lobbiesRepo.listOpenLobbiesForUser(userId),
    ]);
    if (activeMatch || openLobbies.length > 0) {
      socket.emit('error', {
        code: 'RANKED_QUEUE_BLOCKED',
        message: 'Leave your current lobby or match before ranked matchmaking',
      });
      return;
    }

    const lockKey = `lock:ranked:mm:join:${userId}`;
    const lock = await acquireLock(lockKey, 2000);
    if (!lock.acquired || !lock.token) {
      socket.emit('error', {
        code: 'RANKED_QUEUE_BUSY',
        message: 'Ranked queue is busy, retry in a moment',
      });
      return;
    }

    try {
      const now = Date.now();
      const deadlineAt = now + SEARCH_DURATION_MS;

      const existingSearchId = await redis.hGet(USER_MAP_KEY, userId);
      if (existingSearchId) {
        const existing = await redis.hGetAll(searchKey(existingSearchId));
        if (existing.status === 'queued') {
          const remainingMs = Math.max(0, Number(existing.deadlineAt ?? String(deadlineAt)) - now);
          socket.emit('ranked:search_started', { durationMs: remainingMs || SEARCH_DURATION_MS });
          return;
        }
        await redis.hDel(USER_MAP_KEY, userId);
      }

      const newSearchId = randomUUID();
      await redis
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
