import { logger } from '../../core/logger.js';
import { matchVisibilityEventsRepo } from '../../modules/matches/match-visibility-events.repo.js';
import { getCachedPlayer, getMatchCacheOrRebuild } from '../match-cache.js';
import { getRedisClient } from '../redis.js';
import { telemetryDbTaskLimiter } from '../socket-db-task-limiter.js';
import type { QuizballSocket } from '../socket-server.js';
import type { MatchVisibilitySignalPayload } from '../schemas/match.schemas.js';

/**
 * Shadow anti-cheat telemetry: persists client tab/app visibility transitions
 * during an active match, server-stamped and enriched from the match cache.
 * Detection-only — nothing here may ever affect gameplay, so every failure
 * path (room check, rate limit, cache miss, limiter admission, insert) drops
 * the event silently instead of surfacing.
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
  // No Redis → allow: the telemetry limiter still bounds write pressure, and
  // dropping telemetry because the throttle store blinked would bias the data.
  if (!redis?.isOpen) return true;
  try {
    // INCR + EXPIRE in one MULTI so a crash between them can never strand a
    // TTL-less key (which would throttle this user+match forever). Refreshing
    // the TTL every event is intentional: a continuous spammer stays capped
    // until they go quiet for a full window.
    const key = visibilityRateKey(matchId, userId);
    const replies = await redis
      .multi()
      .incr(key)
      .expire(key, RATE_LIMIT_WINDOW_SEC)
      .exec();
    const count = Number(replies?.[0] ?? 0);
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

  // Cheap in-memory gate BEFORE any Redis or DB work: only sockets that
  // joined this match's room may generate load for its matchId. Without it an
  // authenticated client could spray random UUIDs and force a cache-rebuild
  // DB read per event. (A participant emitting before the room join lands
  // just loses that one telemetry row — acceptable.)
  if (!socket.rooms.has(`match:${payload.matchId}`)) return;

  // Stamp NOW, before any queueing: the DB insert rides the task limiter and
  // can land seconds later under load; analysis correlates on occurred_at.
  const occurredAt = new Date();

  if (!(await allowUnderRateLimit(payload.matchId, userId))) {
    logger.debug(
      { matchId: payload.matchId, userId },
      'match:visibility_signal rate limit exceeded; dropping event'
    );
    return;
  }

  let cache;
  try {
    cache = await getMatchCacheOrRebuild(payload.matchId);
  } catch (error) {
    logger.debug(
      { err: error, matchId: payload.matchId, userId },
      'match:visibility_signal cache lookup failed; dropping event'
    );
    return;
  }
  if (!cache || cache.status !== 'active') return;
  if (!getCachedPlayer(cache, userId)) return;

  const question = cache.currentQuestion;
  telemetryDbTaskLimiter
    .run(async () => {
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
    })
    .catch(() => {
      // Limiter admission rejected (queue full / wait timeout): drop the
      // event. An unhandled rejection here would trip the bootstrap
      // rejection-storm guard and restart the replica over telemetry.
    });
}
