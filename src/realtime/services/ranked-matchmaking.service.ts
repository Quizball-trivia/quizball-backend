import { randomUUID } from 'crypto';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { config } from '../../core/config.js';
import { countryPayload } from '../../core/country.js';
import { logger } from '../../core/logger.js';
import { getRedisClient } from '../redis.js';
import { acquireLock, releaseLock } from '../locks.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import { rankedService } from '../../modules/ranked/ranked.service.js';
import { statsService } from '../../modules/stats/stats.service.js';
import { storeService } from '../../modules/store/store.service.js';
import { parseStoredAvatarCustomization } from '../../modules/users/avatar-customization.js';
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
const CANCEL_KEY_PREFIX = 'ranked:mm:cancel:';
const CANCEL_KEY_TTL_SEC = 30;
const TICK_LOCK_KEY = 'ranked:mm:tick-lock';

let loopTimer: NodeJS.Timeout | null = null;
let loopIo: QuizballServer | null = null;

function searchKey(searchId: string): string {
  return `${SEARCH_KEY_PREFIX}${searchId}`;
}

function cancelKey(userId: string): string {
  return `${CANCEL_KEY_PREFIX}${userId}`;
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

function emitInsufficientTickets(
  io: QuizballServer,
  userId: string,
  source: string,
  tickets: number
): void {
  io.to(`user:${userId}`).emit('ranked:queue_left');
  io.to(`user:${userId}`).emit('error', {
    code: 'INSUFFICIENT_TICKETS',
    message: 'You need a ticket to start ranked.',
    meta: {
      source,
      tickets,
    },
  });
}

async function getRankedTicketWallets(userIds: string[]): Promise<Record<string, { coins: number; tickets: number }>> {
  const entries = await Promise.all(
    [...new Set(userIds)].map(async (userId) => {
      const wallet = await storeService.getWallet(userId);
      return [userId, wallet] as const;
    })
  );
  return Object.fromEntries(entries);
}

async function hasTicketForRankedQueue(io: QuizballServer, userId: string, source: string): Promise<boolean> {
  const wallet = await storeService.getWallet(userId);
  if (wallet.tickets >= 1) {
    logger.info({ userId, source, tickets: wallet.tickets }, 'Ranked ticket preflight passed');
    return true;
  }

  logger.warn({ userId, source, tickets: wallet.tickets }, 'Ranked ticket preflight blocked queue start');
  emitInsufficientTickets(io, userId, source, wallet.tickets);
  await userSessionGuardService.emitState(io, userId);
  return false;
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
  userBId: string,
  sessionCountries?: {
    userA?: string | null;
    userB?: string | null;
  }
): Promise<void> {
  await withSpan('ranked.match_found.human', {
    'quizball.user_a_id': userAId,
    'quizball.user_b_id': userBId,
  }, async (span) => {
    if (userAId === userBId) return;

    const redis = getRedisClient();
    if (redis) {
      const [userACancelled, userBCancelled] = await Promise.all([
        redis.get(cancelKey(userAId)),
        redis.get(cancelKey(userBId)),
      ]);
      if (userACancelled || userBCancelled) {
        logger.info(
          { userAId, userBId, userACancelled: Boolean(userACancelled), userBCancelled: Boolean(userBCancelled) },
          'Ranked human match creation skipped because a player cancelled search'
        );
        span.setAttribute('quizball.skipped_cancelled', true);
        return;
      }
    }
    const isCancelled = async () => {
      const latestRedis = getRedisClient();
      if (!latestRedis) return false;
      const [userACancelled, userBCancelled] = await Promise.all([
        latestRedis.get(cancelKey(userAId)),
        latestRedis.get(cancelKey(userBId)),
      ]);
      return Boolean(userACancelled || userBCancelled);
    };

    const usersById = await usersRepo.getByIds([userAId, userBId]);
    const userA = usersById.get(userAId) ?? null;
    const userB = usersById.get(userBId) ?? null;
    if (!userA || !userB) {
      logger.warn({ userAId, userBId }, 'Ranked pairing skipped: user missing');
      span.setAttribute('quizball.skipped_missing_user', true);
      return;
    }

    const [profileA, profileB] = await Promise.all([
      rankedService.ensureProfile(userAId),
      rankedService.ensureProfile(userBId),
    ]);
    const wallets = await getRankedTicketWallets([userAId, userBId]);
    const insufficientUserIds = [userAId, userBId].filter((userId) => (wallets[userId]?.tickets ?? 0) < 1);
    if (insufficientUserIds.length > 0) {
      logger.warn(
        {
          userAId,
          userBId,
          insufficientUserIds,
          wallets,
        },
        'Ranked human match creation skipped: insufficient tickets after pairing'
      );
      for (const userId of [userAId, userBId].filter((id) => !insufficientUserIds.includes(id))) {
        io.to(`user:${userId}`).emit('ranked:queue_left');
      }
      for (const userId of insufficientUserIds) {
        emitInsufficientTickets(io, userId, 'ranked_human_pair_preflight', wallets[userId]?.tickets ?? 0);
      }
      await Promise.all([userSessionGuardService.emitState(io, userAId), userSessionGuardService.emitState(io, userBId)]);
      span.setAttribute('quizball.skipped_insufficient_tickets', true);
      return;
    }
    if (await isCancelled()) {
      logger.info({ userAId, userBId }, 'Ranked human match creation skipped because a player cancelled before lobby creation');
      span.setAttribute('quizball.skipped_cancelled_before_lobby', true);
      return;
    }

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
    await Promise.all([
      userSessionGuardService.emitState(io, userAId),
      userSessionGuardService.emitState(io, userBId),
    ]);

    const [formA, formB] = await Promise.all([
      statsService.getRecentFormForUser(userAId, 3).catch(() => [] as Array<'W' | 'L' | 'D'>),
      statsService.getRecentFormForUser(userBId, 3).catch(() => [] as Array<'W' | 'L' | 'D'>),
    ]);

    io.to(`user:${userAId}`).emit('ranked:match_found', {
      lobbyId: lobby.id,
      myRecentForm: formA,
      opponent: {
        id: userB.id,
        username: userB.nickname ?? 'Player',
        avatarUrl: userB.avatar_url,
        avatarCustomization: parseStoredAvatarCustomization(userB.avatar_customization),
        favoriteClub: userB.favorite_club ?? null,
        recentForm: formB,
        rp: profileB.rp,
        ...countryPayload(sessionCountries?.userB ?? userB.country),
      },
    });
    io.to(`user:${userBId}`).emit('ranked:match_found', {
      lobbyId: lobby.id,
      myRecentForm: formB,
      opponent: {
        id: userA.id,
        username: userA.nickname ?? 'Player',
        avatarUrl: userA.avatar_url,
        avatarCustomization: parseStoredAvatarCustomization(userA.avatar_customization),
        favoriteClub: userA.favorite_club ?? null,
        recentForm: formA,
        rp: profileA.rp,
        ...countryPayload(sessionCountries?.userA ?? userA.country),
      },
    });

    logger.info({ lobbyId: lobby.id, userAId, userBId }, 'Ranked human match found');
    appMetrics.rankedHumanMatches.add(1);

    setTimeout(() => {
      void (async () => {
        if (await isCancelled()) {
          logger.info({ lobbyId: lobby.id, userAId, userBId }, 'Ranked human draft start skipped because a player cancelled search');
          return;
        }
        const latest = await lobbiesRepo.getById(lobby.id);
        if (!latest || latest.status !== 'waiting' || latest.mode !== 'ranked') return;
        await startDraft(io, lobby.id);
      })();
    }, FOUND_MODAL_MS);
  });
}

async function startAiFallbackWithCountry(
  io: QuizballServer,
  userId: string,
  playerCountryCode: string | null | undefined,
): Promise<void> {
  await withSpan('ranked.fallback_to_ai', {
    'quizball.user_id': userId,
  }, async () => {
    const redis = getRedisClient();
    if (redis && await redis.get(cancelKey(userId))) {
      logger.info({ userId }, 'Ranked matchmaking fallback skipped because user cancelled search');
      return;
    }
    if (!await hasTicketForRankedQueue(io, userId, 'ranked_ai_fallback_preflight')) {
      return;
    }
    await startRankedAiForUser(io, userId, {
      skipSearchEmit: true,
      ...(playerCountryCode ? { playerCountryCode } : {}),
    });
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
      const countryCode = result[1] || null;
      fallbackCount += 1;
      await startAiFallbackWithCountry(io, userId, countryCode);
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
      const hasCountryCodes = result.length >= 6;
      const userACountryCode = hasCountryCodes ? result[2] || null : null;
      const userBId = hasCountryCodes ? result[4] : result[3];
      const userBCountryCode = hasCountryCodes ? result[5] || null : null;
      if (!userAId || !userBId) break;
      pairCount += 1;
      await startHumanRankedMatch(io, userAId, userBId, {
        userA: userACountryCode,
        userB: userBCountryCode,
      });
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
      if (!await hasTicketForRankedQueue(io, userId, 'ranked_queue_join_preflight')) {
        span.setAttribute('quizball.queue_block_reason', 'INSUFFICIENT_TICKETS');
        return;
      }

      if (!config.RANKED_HUMAN_QUEUE_ENABLED) {
        logger.info({ userId }, 'Ranked human queue disabled, routing to AI');
        span.setAttribute('quizball.queue_mode', 'ai_only');
        const redis = getRedisClient();
        if (redis) {
          await redis.del(cancelKey(userId));
        }
        await startRankedAiForUser(io, userId, {
          ...(socket.data.currentCountry ? { playerCountryCode: socket.data.currentCountry } : {}),
        });
        return;
      }

      const redis = getRedisClient();
      if (!redis) {
        logger.warn({ userId }, 'Redis unavailable for ranked queue join, falling back to AI');
        span.setAttribute('quizball.queue_fallback', 'redis_unavailable');
        await startRankedAiForUser(io, userId, {
          ...(socket.data.currentCountry ? { playerCountryCode: socket.data.currentCountry } : {}),
        });
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

          await redis.del(cancelKey(userId));

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
          const searchFields: Record<string, string> = {
            userId,
            status: 'queued',
            queuedAt: String(now),
            deadlineAt: String(deadlineAt),
          };
          if (socket.data.currentCountry) {
            searchFields.countryCode = socket.data.currentCountry;
          }

          const multiResult = await redis
            .multi()
            .hSet(searchKey(newSearchId), searchFields)
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
          await redis.set(cancelKey(userId), '1', { EX: CANCEL_KEY_TTL_SEC });
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
          const snapshot = await userSessionGuardService.cleanupRankedQueueArtifacts(io, userId);
          io.to(`user:${userId}`).emit('session:state', snapshot);
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
	      if (socket.data.matchId || socket.data.lobbyId) {
	        span.setAttribute('quizball.skipped_due_to_active_session', true);
	        logger.debug(
	          {
	            userId,
	            matchId: socket.data.matchId ?? null,
	            lobbyId: socket.data.lobbyId ?? null,
	          },
	          'Ranked disconnect cleanup skipped for active match/lobby socket'
	        );
	        return;
	      }

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
