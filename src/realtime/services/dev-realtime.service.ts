import { logger } from '../../core/logger.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import { matchesService } from '../../modules/matches/matches.service.js';
import { generateRankedAiProfile, rankedAiMatchKey } from '../ai-ranked.constants.js';
import { getRedisClient } from '../redis.js';
import { acquireLock, releaseLock } from '../locks.js';
import { beginMatchForLobby } from './match-realtime.service.js';
import { devSkipToPossessionPhase, resumePossessionMatchQuestion } from '../possession-match-flow.js';
import { cancelMatchQuestionTimer } from '../match-flow.js';
import { getMatchCacheOrRebuild } from '../match-cache.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';

const AI_REDIS_TTL_SEC = 7200;
const DEV_MATCH_START_COUNTDOWN_SEC = 0;
const DEV_MATCHES_TO_KEEP = 5;
const DEV_PAUSE_TTL_SEC = 3600;

function devPauseKey(matchId: string): string {
  return `match:devPaused:${matchId}`;
}

// In-process queue of dispatch callbacks deferred while a match was paused.
// On resume, we drain and invoke them. This is single-pod (sufficient for dev tooling).
const pendingDispatches = new Map<string, Array<() => void>>();

/**
 * Returns true if the match is currently dev-paused; defers `dispatch` to be
 * invoked on resume. Callers should `return` (skip their own dispatch) when this
 * resolves true. Best-effort: with Redis unavailable, returns false.
 *
 * The dev-pause Redis value stores the pause-started timestamp (epoch ms) as a
 * string so resume can compute the deadline shift. Any non-null value means
 * paused.
 */
export async function checkDevPauseAndDefer(
  matchId: string,
  dispatch: () => void
): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return false;
  let paused: string | null;
  try {
    paused = await redis.get(devPauseKey(matchId));
  } catch (err) {
    logger.warn({ err, matchId }, 'Dev pause check failed; proceeding with normal dispatch');
    return false;
  }
  if (!paused) return false;
  const queue = pendingDispatches.get(matchId) ?? [];
  queue.push(dispatch);
  pendingDispatches.set(matchId, queue);
  logger.info({ matchId, queued: queue.length }, 'Dev pause: deferred dispatch');
  return true;
}

async function pauseMatchInternal(matchId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) {
    logger.warn({ matchId }, 'Dev pause skipped: Redis unavailable');
    return;
  }

  const pauseStartedAtMs = Date.now();
  await redis.set(devPauseKey(matchId), String(pauseStartedAtMs), { EX: DEV_PAUSE_TTL_SEC });

  // Cancel the active question's answer-timeout so the server won't force-
  // resolve the round while paused. The disconnect-pause flow uses the same
  // primitive.
  const cache = await getMatchCacheOrRebuild(matchId);
  if (cache?.currentQuestion) {
    cancelMatchQuestionTimer(matchId, cache.currentQuestion.qIndex);
    logger.info({ matchId, qIndex: cache.currentQuestion.qIndex }, 'Dev pause: cancelled active question timer');
  }
  logger.info({ matchId, pauseStartedAtMs }, 'Dev pause: match paused');
}

async function resumeMatchInternal(io: QuizballServer, matchId: string): Promise<void> {
  const redis = getRedisClient();
  let pauseStartedAtMs: number | null = null;
  if (redis?.isOpen) {
    const raw = await redis.get(devPauseKey(matchId));
    if (raw) {
      const parsed = Number(raw);
      pauseStartedAtMs = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    await redis.del(devPauseKey(matchId));
  }

  // Re-emit the active question with a deadline shifted forward by the pause
  // duration. Same helper the disconnect-pause uses.
  if (pauseStartedAtMs !== null) {
    const cache = await getMatchCacheOrRebuild(matchId);
    if (cache?.currentQuestion) {
      try {
        const resumed = await resumePossessionMatchQuestion(
          io,
          matchId,
          cache.currentQuestion.qIndex,
          pauseStartedAtMs
        );
        logger.info({ matchId, qIndex: cache.currentQuestion.qIndex, resumed }, 'Dev resume: resumed question');
      } catch (err) {
        logger.warn({ err, matchId }, 'Dev resume: resumePossessionMatchQuestion threw');
      }
    }
  }

  // Drain any next-question dispatches that were held while paused.
  const queue = pendingDispatches.get(matchId);
  pendingDispatches.delete(matchId);
  if (queue?.length) {
    logger.info({ matchId, count: queue.length }, 'Dev resume: firing deferred dispatches');
    for (const dispatch of queue) {
      try { dispatch(); } catch (err) {
        logger.warn({ err, matchId }, 'Deferred dev dispatch threw');
      }
    }
  }
}

async function cleanupFailedQuickMatchLobby(
  socket: QuizballSocket,
  lobbyId: string,
  userId: string,
  aiUserId: string
): Promise<void> {
  try {
    await Promise.allSettled([
      lobbiesRepo.removeMember(lobbyId, userId),
      lobbiesRepo.removeMember(lobbyId, aiUserId),
    ]);
    await lobbiesRepo.deleteLobby(lobbyId);
    await usersRepo.deleteAiUser(aiUserId);
  } catch (err) {
    logger.warn({ err, lobbyId, userId, aiUserId }, 'Failed to fully clean up dev quick-match lobby');
  } finally {
    socket.leave(`lobby:${lobbyId}`);
  }
}

/**
 * Dev-only realtime service for fast iteration tooling.
 * Intentionally shortcuts the normal layered flow (directly calls repos + services)
 * to quickly bootstrap matches for testing. Guarded by NODE_ENV check in the handler.
 */
export const devRealtimeService = {
  async handleQuickMatch(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const userId = socket.data.user.id;
    const completed = await userSessionGuardService.runWithUserTransitionLock(
      io,
      socket,
      async () => {
        const prepared = await userSessionGuardService.prepareForLobbyEntry(io, userId);
        if (!prepared.ok) {
          userSessionGuardService.emitBlocked(socket, {
            reason: prepared.reason ?? 'ACTIVE_MATCH',
            message: prepared.message ?? 'You are already in an active match',
            operation: 'dev:quick_match',
            stateSnapshot: prepared.snapshot,
          });
          socket.emit('error', {
            code: 'DEV_ERROR',
            message: prepared.message ?? 'Quick match blocked by session state',
            meta: { stateSnapshot: prepared.snapshot },
          });
          return;
        }

        // 0. Clean up old dev matches (keep most recent N)
        try {
          const cleaned = await matchesService.cleanupOldDevMatches(DEV_MATCHES_TO_KEEP);
          if (cleaned > 0) {
            logger.info({ cleaned }, 'Cleaned up old dev matches');
          }
        } catch (err) {
          logger.warn({ err }, 'Dev match cleanup failed; continuing');
        }

        // 1. Create AI opponent
        const aiProfile = generateRankedAiProfile();
        const aiUser = await usersRepo.create({
          nickname: aiProfile.username,
          avatarUrl: aiProfile.avatarUrl,
          isAi: true,
        });

        // 2. Create lobby (mode: 'ranked' allows null invite code per DB constraint)
        const lobby = await lobbiesRepo.createLobby({
          mode: 'ranked',
          hostUserId: userId,
          inviteCode: null,
        });

        // 3. Add both players
        await lobbiesRepo.addMember(lobby.id, userId, true);
        await lobbiesRepo.addMember(lobby.id, aiUser.id, true);

        // 4. Join socket to lobby room (beginMatchForLobby reads from this)
        socket.join(`lobby:${lobby.id}`);

        // 5. Pick both ranked-eligible categories up front so dev quick matches skip halftime banning.
        const categories = await lobbiesService.selectRandomRankedCategories(2);
        if (categories.length < 2) {
          await cleanupFailedQuickMatchLobby(socket, lobby.id, userId, aiUser.id);
          socket.emit('error', { code: 'DEV_ERROR', message: 'Not enough ranked categories with full coverage' });
          return;
        }

        // 6. Create match via production service (marked as dev)
        const result = await matchesService.createMatchFromLobby({
          lobbyId: lobby.id,
          mode: 'ranked',
          variant: 'ranked_sim',
          hostUserId: userId,
          categoryAId: categories[0].id,
          categoryBId: categories[1].id,
          isDev: true,
        });

        // 7. Set AI Redis key so AI answer scheduling works
        const redis = getRedisClient();
        if (redis?.isOpen) {
          await redis.set(rankedAiMatchKey(result.match.id), aiUser.id, { EX: AI_REDIS_TTL_SEC });
        } else {
          logger.warn({ matchId: result.match.id }, 'Redis unavailable during dev quick match; continuing without AI Redis marker');
        }

        // 8. Start match (emits match:start, moves socket, sends first question)
        await beginMatchForLobby(io, lobby.id, result.match.id, {
          countdownSec: DEV_MATCH_START_COUNTDOWN_SEC,
        });

        logger.info(
          {
            matchId: result.match.id,
            userId,
            aiUserId: aiUser.id,
            categoryAId: categories[0].id,
            categoryBId: categories[1].id,
          },
          'Dev quick match started'
        );
      },
      {
        message: 'Quick match transition is in progress. Please retry.',
        operation: 'dev:quick_match',
      }
    );

    if (!completed) return;
  },

  async handleSkipTo(
    _io: QuizballServer,
    payload: { matchId: string; target: 'halftime' | 'last_attack' | 'shot' | 'penalties' | 'second_half' }
  ): Promise<void> {
    await devSkipToPossessionPhase(_io, payload.matchId, payload.target);

    logger.info({ matchId: payload.matchId, target: payload.target }, 'Dev skip executed');
  },

  async handlePauseMatch(payload: { matchId: string }): Promise<void> {
    const lockKey = `lock:match:${payload.matchId}:dev_pause`;
    const lock = await acquireLock(lockKey, 5000);
    if (!lock.acquired || !lock.token) {
      logger.warn({ matchId: payload.matchId }, 'Dev pause skipped: could not acquire lock');
      return;
    }
    try {
      await pauseMatchInternal(payload.matchId);
    } finally {
      await releaseLock(lockKey, lock.token);
    }
  },

  async handleResumeMatch(io: QuizballServer, payload: { matchId: string }): Promise<void> {
    const lockKey = `lock:match:${payload.matchId}:dev_pause`;
    const lock = await acquireLock(lockKey, 5000);
    if (!lock.acquired || !lock.token) {
      logger.warn({ matchId: payload.matchId }, 'Dev resume skipped: could not acquire lock');
      return;
    }
    try {
      await resumeMatchInternal(io, payload.matchId);
    } finally {
      await releaseLock(lockKey, lock.token);
    }
  },
};
