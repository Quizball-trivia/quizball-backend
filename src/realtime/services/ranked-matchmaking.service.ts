import { randomUUID } from 'crypto';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { getRedisClient } from '../redis.js';
import { acquireLock, releaseLock } from '../locks.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import { rankedService } from '../../modules/ranked/ranked.service.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { startDraft, startRankedAiForUser } from './lobby-realtime.service.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import { withSpan } from '../../core/tracing.js';
import { appMetrics } from '../../core/metrics.js';
import {
  RANKED_MM_CANCEL_SEARCH_SCRIPT,
  RANKED_MM_CLAIM_FALLBACK_SCRIPT,
  RANKED_MM_PAIR_TWO_RANDOM_SCRIPT,
} from '../lua/ranked-matchmaking.scripts.js';

const SEARCH_DURATION_MS = 7000;
const SEARCH_KEY_TTL_SEC = 60;
const TICK_INTERVAL_MS = 100;
// Keep lock alive across worst-case tick I/O so parallel ticks cannot overlap.
const TICK_LOCK_TTL_MS = SEARCH_DURATION_MS;
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
  await withSpan('ranked.match_found.human', {
    'quizball.user_a_id': userAId,
    'quizball.user_b_id': userBId,
  }, async (span) => {
    if (userAId === userBId) return;

    const [userA, userB] = await Promise.all([
      usersRepo.getById(userAId),
      usersRepo.getById(userBId),
    ]);
    if (!userA || !userB) {
      logger.warn({ userAId, userBId }, 'Ranked pairing skipped: user missing');
      span.setAttribute('quizball.skipped_missing_user', true);
      return;
    }

    const [profileA, profileB] = await Promise.all([
      rankedService.ensureProfile(userAId),
      rankedService.ensureProfile(userBId),
    ]);

    const lobby = await lobbiesRepo.createLobby({
      mode: 'ranked',
      hostUserId: userAId,
      inviteCode: null,
    });

    span.setAttribute('quizball.lobby_id', lobby.id);

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
        rp: profileB.rp,
      },
    });
    io.to(`user:${userBId}`).emit('ranked:match_found', {
      lobbyId: lobby.id,
      opponent: {
        id: userA.id,
        username: userA.nickname ?? 'Player',
        avatarUrl: userA.avatar_url,
        rp: profileA.rp,
      },
    });

    logger.info({ lobbyId: lobby.id, userAId, userBId }, 'Ranked human match found');
    appMetrics.rankedHumanMatches.add(1);

    setTimeout(() => {
      void (async () => {
        const latest = await lobbiesRepo.getById(lobby.id);
        if (!latest || latest.status !== 'waiting' || latest.mode !== 'ranked') return;
        await startDraft(io, lobby.id);
      })();
    }, FOUND_MODAL_MS);
  });
}

async function startAiFallback(io: QuizballServer, userId: string): Promise<void> {
  await withSpan('ranked.fallback_to_ai', {
    'quizball.user_id': userId,
  }, async () => {
    await startRankedAiForUser(io, userId, { skipSearchEmit: true });
    logger.info({ userId }, 'Ranked matchmaking fallback to AI');
    appMetrics.rankedAiFallbacks.add(1);
  });
}

async function processFallbacks(io: QuizballServer): Promise<void> {
  await withSpan('ranked.process_fallbacks', {}, async (span) => {
    const redis = getRedisClient();
    if (!redis) {
      span.setAttribute('quizball.redis_available', false);
      return;
    }

    const now = Date.now();
    const due = await redis.zRangeByScore(TIMEOUTS_KEY, 0, now, {
      LIMIT: { offset: 0, count: MAX_FALLBACKS_PER_TICK },
    });
    span.setAttribute('quizball.due_search_count', due.length);

    let fallbackCount = 0;
    for (const searchId of due) {
      const resultRaw = await redis.eval(RANKED_MM_CLAIM_FALLBACK_SCRIPT, {
        keys: [QUEUE_KEY, TIMEOUTS_KEY, USER_MAP_KEY, searchKey(searchId)],
        arguments: [searchId, String(now), String(now)],
      });
      const result = toStringArray(resultRaw);
      const userId = result[0];
      if (!userId) continue;
      fallbackCount += 1;
      await startAiFallback(io, userId);
    }
    span.setAttribute('quizball.fallback_count', fallbackCount);
  });
}

async function processPairs(io: QuizballServer): Promise<void> {
  await withSpan('ranked.process_pairs', {}, async (span) => {
    const redis = getRedisClient();
    if (!redis) {
      span.setAttribute('quizball.redis_available', false);
      return;
    }

    let pairCount = 0;
    for (let i = 0; i < MAX_PAIRS_PER_TICK; i += 1) {
      const resultRaw = await redis.eval(RANKED_MM_PAIR_TWO_RANDOM_SCRIPT, {
        keys: [QUEUE_KEY, TIMEOUTS_KEY, USER_MAP_KEY],
        arguments: [SEARCH_KEY_PREFIX, String(Date.now())],
      });
      const result = toStringArray(resultRaw);
      if (result.length < 4) break;

      const userAId = result[1];
      const userBId = result[3];
      if (!userAId || !userBId) break;
      pairCount += 1;
      await startHumanRankedMatch(io, userAId, userBId);
    }
    span.setAttribute('quizball.pair_count', pairCount);
  });
}

async function rankedTick(): Promise<void> {
  await withSpan('ranked.tick', {}, async (span) => {
    if (!loopIo) {
      span.setAttribute('quizball.loop_active', false);
      return;
    }

    const redis = getRedisClient();
    if (!redis) {
      span.setAttribute('quizball.redis_available', false);
      return;
    }

    const lock = await acquireLock(TICK_LOCK_KEY, TICK_LOCK_TTL_MS);
    if (!lock.acquired || !lock.token) {
      span.setAttribute('quizball.tick_lock_acquired', false);
      return;
    }

    span.setAttribute('quizball.tick_lock_acquired', true);
    try {
      await processFallbacks(loopIo);
      await processPairs(loopIo);
    } catch (error) {
      logger.error({ err: error }, 'Ranked matchmaking tick failed');
      throw error;
    } finally {
      await releaseLock(TICK_LOCK_KEY, lock.token);
    }
  });
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
    await withSpan('ranked.queue_join', {
      'quizball.user_id': userId,
    }, async (span) => {
      logger.info({ userId }, 'Ranked queue join requested');
      appMetrics.rankedQueueJoins.add(1);

      if (!config.RANKED_HUMAN_QUEUE_ENABLED) {
        logger.info({ userId }, 'Ranked human queue disabled, routing to AI');
        span.setAttribute('quizball.queue_mode', 'ai_only');
        await startRankedAiForUser(io, userId);
        return;
      }

      const redis = getRedisClient();
      if (!redis) {
        logger.warn({ userId }, 'Redis unavailable for ranked queue join, falling back to AI');
        span.setAttribute('quizball.queue_fallback', 'redis_unavailable');
        await startRankedAiForUser(io, userId);
        return;
      }

      const completed = await userSessionGuardService.runWithUserTransitionLock(
        io,
        socket,
        async () => {
          const prepared = await userSessionGuardService.prepareForQueueJoin(io, userId);
          logger.info(
            {
              userId,
              state: prepared.snapshot.state,
              activeMatchId: prepared.snapshot.activeMatchId,
              waitingLobbyId: prepared.snapshot.waitingLobbyId,
              queueSearchId: prepared.snapshot.queueSearchId,
            },
            'Ranked queue join session prepared'
          );
          span.setAttributes({
            'quizball.session_state': prepared.snapshot.state,
            'quizball.active_match_id': prepared.snapshot.activeMatchId ?? '',
            'quizball.waiting_lobby_id': prepared.snapshot.waitingLobbyId ?? '',
          });
          if (!prepared.ok) {
            logger.warn(
              {
                userId,
                reason: prepared.reason ?? 'ACTIVE_MATCH',
                state: prepared.snapshot.state,
                activeMatchId: prepared.snapshot.activeMatchId,
                waitingLobbyId: prepared.snapshot.waitingLobbyId,
                queueSearchId: prepared.snapshot.queueSearchId,
              },
              'Ranked queue join blocked by session state'
            );
            span.setAttribute('quizball.queue_block_reason', prepared.reason ?? 'ACTIVE_MATCH');
            userSessionGuardService.emitBlocked(socket, {
              reason: prepared.reason ?? 'ACTIVE_MATCH',
              message: prepared.message ?? 'You are already in an active match',
              stateSnapshot: prepared.snapshot,
            });
            socket.emit('error', {
              code: 'RANKED_QUEUE_BLOCKED',
              message: prepared.message ?? 'You are already in an active match',
              meta: { stateSnapshot: prepared.snapshot },
            });
            return;
          }

          const now = Date.now();
          const deadlineAt = now + SEARCH_DURATION_MS;
          const existingSearchId = await redis.hGet(USER_MAP_KEY, userId);
          if (existingSearchId) {
            const existing = await redis.hGetAll(searchKey(existingSearchId));
            if (existing.status === 'queued') {
              // Validate and parse deadlineAt defensively
              const parsedDeadline = Number(existing.deadlineAt);
              let remainingMs: number;

              if (!existing.deadlineAt || !Number.isFinite(parsedDeadline) || parsedDeadline <= 0) {
                // Invalid or missing deadlineAt - fallback to full duration
                logger.warn(
                  {
                    userId,
                    searchId: existingSearchId,
                    invalidDeadlineAt: existing.deadlineAt ?? null,
                    queuedAt: existing.queuedAt ?? null,
                  },
                  'Ranked queue resume found invalid deadlineAt, using fallback duration'
                );
                remainingMs = SEARCH_DURATION_MS;
              } else {
                remainingMs = Math.max(0, parsedDeadline - now);
              }

              logger.info(
                {
                  userId,
                  searchId: existingSearchId,
                  remainingMs,
                  queuedAt: existing.queuedAt ?? null,
                  deadlineAt: existing.deadlineAt ?? null,
                },
                'Ranked queue join resumed existing queue'
              );
              socket.emit('ranked:search_started', { durationMs: remainingMs || SEARCH_DURATION_MS });
              const snapshot = await userSessionGuardService.emitState(io, userId);
              logger.info(
                {
                  userId,
                  state: snapshot.state,
                  queueSearchId: snapshot.queueSearchId,
                  activeMatchId: snapshot.activeMatchId,
                  waitingLobbyId: snapshot.waitingLobbyId,
                },
                'Ranked queue state emitted after resume'
              );
              return;
            }
            logger.warn(
              {
                userId,
                searchId: existingSearchId,
                status: existing.status ?? null,
              },
              'Ranked queue join found stale user-map search id'
            );
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
          const queueSize = await redis.zCard(QUEUE_KEY);
          span.setAttribute('quizball.queue_size', queueSize);
          logger.info({ userId, searchId: newSearchId, queueSize }, 'User joined ranked queue');
          const snapshot = await userSessionGuardService.emitState(io, userId);
          logger.info(
            {
              userId,
              state: snapshot.state,
              queueSearchId: snapshot.queueSearchId,
              activeMatchId: snapshot.activeMatchId,
              waitingLobbyId: snapshot.waitingLobbyId,
            },
            'Ranked queue state emitted after join'
          );
        },
        {
          code: 'RANKED_QUEUE_BUSY',
          message: 'Session transition is in progress. Please retry.',
          operation: 'ranked:queue_join',
        }
      );
      if (!completed) {
        logger.warn({ userId }, 'Ranked queue join transition lock not acquired');
        span.setAttribute('quizball.transition_lock_acquired', false);
        return;
      }
      span.setAttribute('quizball.transition_lock_acquired', true);
    });
  },

  async handleQueueLeave(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const userId = socket.data.user.id;
    await withSpan('ranked.queue_leave', {
      'quizball.user_id': userId,
    }, async (span) => {
      appMetrics.rankedQueueLeaves.add(1);
      const redis = getRedisClient();
      if (!redis) {
        span.setAttribute('quizball.redis_available', false);
        return;
      }

      const completed = await userSessionGuardService.runWithUserTransitionLock(
        io,
        socket,
        async () => {
          const resultRaw = await redis.eval(RANKED_MM_CANCEL_SEARCH_SCRIPT, {
            keys: [QUEUE_KEY, TIMEOUTS_KEY, USER_MAP_KEY],
            arguments: [SEARCH_KEY_PREFIX, userId, String(Date.now())],
          });
          const result = toStringArray(resultRaw);
          span.setAttribute('quizball.queue_search_found', result.length > 0);
          if (result.length > 0) {
            logger.info({ userId, searchId: result[0] }, 'User left ranked queue');
          } else {
            logger.info({ userId }, 'Ranked queue leave requested but no active search found');
          }

          socket.emit('ranked:queue_left');
          const snapshot = await userSessionGuardService.emitState(io, userId);
          logger.info(
            {
              userId,
              state: snapshot.state,
              queueSearchId: snapshot.queueSearchId,
              activeMatchId: snapshot.activeMatchId,
              waitingLobbyId: snapshot.waitingLobbyId,
            },
            'Ranked queue state emitted after leave'
          );
        },
        {
          code: 'RANKED_QUEUE_BUSY',
          message: 'Session transition is in progress. Please retry.',
          operation: 'ranked:queue_leave',
        }
      );
      span.setAttribute('quizball.transition_lock_acquired', completed);
    });
  },

  async handleSocketDisconnect(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const userId = socket.data.user.id;
    await withSpan('ranked.disconnect_cleanup', {
      'quizball.user_id': userId,
    }, async (span) => {
      const redis = getRedisClient();
      if (!redis) {
        span.setAttribute('quizball.redis_available', false);
        return;
      }

      const completed = await userSessionGuardService.runWithUserTransitionLock(
        io,
        socket,
        async () => {
          const resultRaw = await redis.eval(RANKED_MM_CANCEL_SEARCH_SCRIPT, {
            keys: [QUEUE_KEY, TIMEOUTS_KEY, USER_MAP_KEY],
            arguments: [SEARCH_KEY_PREFIX, userId, String(Date.now())],
          });
          const result = toStringArray(resultRaw);
          span.setAttribute('quizball.queue_search_found', result.length > 0);
          if (result.length > 0) {
            logger.info({ userId, searchId: result[0] }, 'Socket disconnect removed ranked queue search');
          }
        },
        {
          operation: 'ranked:disconnect_cleanup',
        }
      );
      span.setAttribute('quizball.transition_lock_acquired', completed);
      if (!completed) return;
      const snapshot = await userSessionGuardService.emitState(io, userId);
      logger.info(
        {
          userId,
          state: snapshot.state,
          queueSearchId: snapshot.queueSearchId,
          activeMatchId: snapshot.activeMatchId,
          waitingLobbyId: snapshot.waitingLobbyId,
        },
        'Ranked queue state emitted after disconnect cleanup'
      );
    });
  },
};
