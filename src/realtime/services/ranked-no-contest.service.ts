import { logger } from '../../core/logger.js';
import { matchPlayersRepo } from '../../modules/matches/match-players.repo.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { matchesService } from '../../modules/matches/matches.service.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { storeService } from '../../modules/store/store.service.js';
import { deleteMatchCache, type MatchCache } from '../match-cache.js';
import { getRedisClient } from '../redis.js';
import { lastMatchKey } from '../match-keys.js';
import { acquireLock, releaseLock, startLockHeartbeat } from '../locks.js';
import type { MatchRow } from '../../modules/matches/matches.types.js';

const FORFEIT_REPLAY_TTL_SEC = 600;

export function matchForfeitKey(matchId: string): string {
  return `match:forfeit:${matchId}`;
}

interface RankedNoContestParams {
  matchId: string;
  roster: Array<{ user_id: string }>;
  statePayload: Record<string, unknown>;
  roundsPlayed: number;
  cleanupRedisKeys?: string[];
  /** Users the refund must SKIP (e.g. a penalized serial forfeiter). */
  suppressRefundUserIds?: string[];
}

/**
 * Cancel a ranked match as a no-contest: abandon it (no winner, no RP change),
 * refund every human participant's consumed ranked ticket, and stamp the
 * replay markers so a reconnecting client sees "no contest" instead of a loss.
 *
 * Shared by the early-forfeit path (a drop before RANKED_EARLY_FORFEIT_MIN_ROUNDS)
 * and the zero-interaction safety net (a ghost match where no human ever
 * submitted an answer) — both must void the match identically.
 */
export async function finalizeRankedNoContest(
  params: RankedNoContestParams
): Promise<number> {
  await matchesRepo.setMatchStatePayload(params.matchId, {
    ...params.statePayload,
    winnerDecisionMethod: 'forfeit',
    cancelledNoContest: true,
    roundsPlayed: params.roundsPlayed,
  });
  await matchesService.abandonMatch(params.matchId);
  await deleteMatchCache(params.matchId);

  const suppressed = new Set(params.suppressRefundUserIds ?? []);
  const rosterUsers = await usersRepo.getByIds(params.roster.map((player) => player.user_id));
  const humanUserIds = params.roster
    .map((player) => rosterUsers.get(player.user_id))
    .filter((user): user is NonNullable<typeof user> => user != null && user.is_ai === false)
    .filter((user) => !suppressed.has(user.id))
    .map((user) => user.id);
  if (humanUserIds.length > 0) {
    try {
      await storeService.refundRankedTickets(humanUserIds);
    } catch (error) {
      logger.warn(
        { error, matchId: params.matchId, humanUserIds },
        'Failed to refund ranked tickets on no-contest cancel'
      );
    }
  }

  const resultVersion = Date.now();
  const redis = getRedisClient();
  if (redis) {
    const cleanupKeys = params.cleanupRedisKeys?.filter(Boolean) ?? [];
    if (cleanupKeys.length > 0) {
      await redis.del(cleanupKeys);
    }
    await redis.set(matchForfeitKey(params.matchId), 'no_contest', {
      EX: FORFEIT_REPLAY_TTL_SEC,
    });
    await Promise.all(
      params.roster.map((player) =>
        redis.set(
          lastMatchKey(player.user_id),
          JSON.stringify({ matchId: params.matchId, resultVersion }),
          { EX: FORFEIT_REPLAY_TTL_SEC }
        )
      )
    );
  }

  return resultVersion;
}

export interface FinalizeRankedNoContestResult {
  matchId: string;
  resultVersion: number;
  completed: boolean;
}

/**
 * Void a ranked match as a no-contest with no forfeiter (zero-interaction
 * safety net): every human got timeout-backfilled the whole match, so there is
 * no legitimate result. Abandon it, refund all humans, and stamp replay
 * markers — the same terminal state as an early forfeit, minus the per-player
 * forfeit penalty since nobody chose to leave.
 */
export async function finalizeRankedMatchAsNoContest(params: {
  matchId: string;
  activeMatch?: MatchRow | null;
  cacheSnapshot?: MatchCache | null;
  cleanupRedisKeys?: string[];
  roundsPlayed: number;
}): Promise<FinalizeRankedNoContestResult> {
  const lockKey = `lock:match:${params.matchId}:complete`;
  const lockTtlMs = 15_000;
  const lock = await acquireLock(lockKey, lockTtlMs);
  if (!lock.acquired || !lock.token) {
    return { matchId: params.matchId, resultVersion: Date.now(), completed: false };
  }
  const heartbeat = startLockHeartbeat(lockKey, lock.token, lockTtlMs);
  try {
    const activeMatch = await matchesRepo.getMatch(params.matchId);
    if (!activeMatch || activeMatch.status !== 'active') {
      return { matchId: params.matchId, resultVersion: Date.now(), completed: false };
    }
    const roster = await matchPlayersRepo.listMatchPlayers(params.matchId);
    const currentPayload = (
      params.cacheSnapshot?.statePayload ?? activeMatch.state_payload ?? {}
    ) as Record<string, unknown>;
    const resultVersion = await finalizeRankedNoContest({
      matchId: params.matchId,
      roster,
      statePayload: currentPayload,
      roundsPlayed: params.roundsPlayed,
      cleanupRedisKeys: params.cleanupRedisKeys,
    });
    logger.info(
      { matchId: params.matchId, roundsPlayed: params.roundsPlayed },
      'Ranked match cancelled as no-contest (zero human interaction) — RP unchanged, tickets refunded'
    );
    return { matchId: params.matchId, resultVersion, completed: true };
  } finally {
    heartbeat.stop();
    await releaseLock(lockKey, lock.token);
  }
}
