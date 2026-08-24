import { logger } from '../../core/logger.js';
import { matchVisibilityEventsRepo } from '../../modules/matches/match-visibility-events.repo.js';
import { getCachedPlayer, getMatchCacheOrRebuild } from '../match-cache.js';
import { getRedisClient } from '../redis.js';
import { socketDbTaskLimiter } from '../socket-db-task-limiter.js';
import type { QuizballSocket } from '../socket-server.js';
import type { MatchVisibilitySignalPayload } from '../schemas/match.schemas.js';

/**
 * Shadow anti-cheat telemetry: persists client tab/app visibility transitions
 * during an active match, server-stamped and enriched from the match cache.
 * Detection-only — nothing here may ever affect gameplay, so every failure
 * path drops the event silently (log at debug/warn) instead of surfacing.
 */

// A tab switch produces 2-4 events (blur+hidden then visible+focus). 30/min
// absorbs pathological switchers; anything past it is a hostile client and
// gets dropped, not stored.
const RATE_LIMIT_WINDOW_SEC = 60;
const RATE_LIMIT_MAX_EVENTS = 30;

function visibilityRateKey(matchId: string, userId: string): string {
  return `match:visibility_rate:${matchId}:${userId}`;
}

async function allowUnderRateLimit(matchId: string, userId: string): Promise<boolean> {
  const redis = getRedisClient();
  // No Redis → allow: the DB task limiter still bounds write pressure, and
  // dropping telemetry because the throttle store blinked would bias the data.
  if (!redis?.isOpen) return true;
  try {
    const key = visibilityRateKey(matchId, userId);
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, RATE_LIMIT_WINDOW_SEC);
    }
    return count <= RATE_LIMIT_MAX_EVENTS;
  } catch {
    return true;
  }
}

export async function handleVisibilitySignal(
  socket: QuizballSocket,
  payload: MatchVisibilitySignalPayload
): Promise<void> {
  const userId = socket.data.user?.id;
  if (!userId) return;

  // Stamp NOW, before any queueing: the DB insert rides the task limiter and
  // can land seconds later under load; analysis correlates on occurred_at.
  const occurredAt = new Date();

  const cache = await getMatchCacheOrRebuild(payload.matchId);
  if (!cache || cache.status !== 'active') return;
  if (!getCachedPlayer(cache, userId)) return;

  if (!(await allowUnderRateLimit(payload.matchId, userId))) {
    logger.debug(
      { matchId: payload.matchId, userId },
      'match:visibility_signal rate limit exceeded; dropping event'
    );
    return;
  }

  const question = cache.currentQuestion;
  void socketDbTaskLimiter.run(async () => {
    try {
      await matchVisibilityEventsRepo.insertVisibilityEvent({
        matchId: payload.matchId,
        userId,
        signal: payload.signal,
        qIndex: question?.qIndex ?? cache.currentQIndex ?? null,
        questionId: question?.questionId ?? null,
        phase: cache.statePayload?.phase ?? null,
        questionKind: question?.kind ?? null,
        questionOpen: question != null,
        mode: cache.mode ?? null,
        occurredAt,
      });
    } catch (error) {
      logger.warn(
        { err: error, matchId: payload.matchId, userId },
        'Failed to persist match visibility event'
      );
    }
  });
}
