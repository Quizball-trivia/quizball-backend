import { logger } from '../../core/logger.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { matchesService, resolveMatchVariant } from '../../modules/matches/matches.service.js';
import type { MatchRow } from '../../modules/matches/matches.types.js';
import { progressionService } from '../../modules/progression/progression.service.js';
import { rankedService } from '../../modules/ranked/ranked.service.js';
import { QUESTION_TIME_MS } from '../match-flow.js';
import { deleteMatchCache, type MatchCache } from '../match-cache.js';
import { getRedisClient } from '../redis.js';
import { lastMatchKey } from '../match-keys.js';
import { buildStandings } from '../match-utils.js';
import { acquireLock, releaseLock } from '../locks.js';

const FORFEIT_REPLAY_TTL_SEC = 600;

function matchForfeitKey(matchId: string): string {
  return `match:forfeit:${matchId}`;
}

export interface FinalizeMatchAsForfeitParams {
  matchId: string;
  forfeitingUserId: string;
  activeMatch?: MatchRow | null;
  cacheSnapshot?: MatchCache | null;
  cleanupRedisKeys?: string[];
}

export interface FinalizeMatchAsForfeitResult {
  matchId: string;
  winnerId: string | null;
  resultVersion: number;
  completed: boolean;
}

export async function finalizeMatchAsForfeit(
  params: FinalizeMatchAsForfeitParams
): Promise<FinalizeMatchAsForfeitResult> {
  const lockKey = `lock:match:${params.matchId}:forfeit`;
  const lock = await acquireLock(lockKey, 15_000);
  if (!lock.acquired || !lock.token) {
    return {
      matchId: params.matchId,
      winnerId: null,
      resultVersion: Date.now(),
      completed: false,
    };
  }

  try {
    const activeMatch = params.activeMatch ?? await matchesRepo.getMatch(params.matchId);
    if (!activeMatch || activeMatch.status !== 'active') {
      return {
        matchId: params.matchId,
        winnerId: null,
        resultVersion: Date.now(),
        completed: false,
      };
    }

    const variant = resolveMatchVariant(activeMatch.state_payload, activeMatch.mode);
    const roster = await matchesRepo.listMatchPlayers(params.matchId);
    const winnerId =
      variant === 'friendly_party_quiz'
        ? buildStandings(
            roster.filter((player) => player.user_id !== params.forfeitingUserId)
          )[0]?.userId ?? null
        : roster.find((player) => player.user_id !== params.forfeitingUserId)?.user_id ?? null;

    if (params.cacheSnapshot && params.cacheSnapshot.status === 'active' && variant !== 'friendly_party_quiz') {
      await matchesRepo.setMatchStatePayload(
        params.matchId,
        params.cacheSnapshot.statePayload,
        params.cacheSnapshot.currentQIndex
      );
      await Promise.all(
        params.cacheSnapshot.players.map((player) =>
          matchesRepo.setPlayerFinalTotals(params.matchId, player.userId, {
            totalPoints: player.totalPoints,
            correctAnswers: player.correctAnswers,
            goals: player.goals,
            penaltyGoals: player.penaltyGoals,
          })
        )
      );
    }

    if (winnerId && variant !== 'friendly_party_quiz') {
      const fullPoints = Math.floor((QUESTION_TIME_MS / 1000) * 10 * activeMatch.total_questions);
      const fullCorrectAnswers = activeMatch.total_questions;
      const winnerPlayer = roster.find((player) => player.user_id === winnerId);
      const currentPoints = winnerPlayer?.total_points ?? 0;
      const currentCorrect = winnerPlayer?.correct_answers ?? 0;

      await matchesRepo.setPlayerForfeitWinTotals(
        params.matchId,
        winnerId,
        Math.max(currentPoints, fullPoints),
        Math.max(currentCorrect, fullCorrectAnswers)
      );
    }

    const currentPayload = (
      params.cacheSnapshot?.statePayload ?? activeMatch.state_payload ?? {}
    ) as Record<string, unknown>;
    await matchesRepo.setMatchStatePayload(params.matchId, {
      ...currentPayload,
      winnerDecisionMethod: 'forfeit',
    });

    await matchesRepo.completeMatch(params.matchId, winnerId);
    await deleteMatchCache(params.matchId);

    if (activeMatch.mode === 'ranked') {
      try {
        await rankedService.settleCompletedRankedMatch(params.matchId);
      } catch (error) {
        logger.warn({ error, matchId: params.matchId }, 'Ranked settlement failed during forfeit finalization');
      }
    }

    try {
      await progressionService.awardCompletedMatchXp(params.matchId);
    } catch (error) {
      logger.warn({ error, matchId: params.matchId }, 'Match XP award failed during forfeit finalization');
    }

    const avgTimes = await matchesService.computeAvgTimes(params.matchId);
    for (const player of roster) {
      await matchesRepo.updatePlayerAvgTime(
        params.matchId,
        player.user_id,
        avgTimes.get(player.user_id) ?? null
      );
    }

    const resultVersion = Date.now();
    const redis = getRedisClient();
    if (redis) {
      const cleanupKeys = params.cleanupRedisKeys?.filter(Boolean) ?? [];
      if (cleanupKeys.length > 0) {
        await redis.del(cleanupKeys);
      }
      await redis.set(matchForfeitKey(params.matchId), winnerId ?? 'draw', {
        EX: FORFEIT_REPLAY_TTL_SEC,
      });
      await Promise.all(
        roster.map((player) =>
          redis.set(
            lastMatchKey(player.user_id),
            JSON.stringify({ matchId: params.matchId, resultVersion }),
            { EX: FORFEIT_REPLAY_TTL_SEC }
          )
        )
      );
    }

    return {
      matchId: params.matchId,
      winnerId,
      resultVersion,
      completed: true,
    };
  } finally {
    await releaseLock(lockKey, lock.token);
  }
}
