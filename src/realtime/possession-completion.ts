import { trackEvent } from '../core/analytics.js';
import { trackMatchCompleted } from '../core/analytics/game-events.js';
import { logger } from '../core/logger.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import { achievementsService } from '../modules/achievements/index.js';
import {
  matchesService,
  type PossessionStatePayload,
} from '../modules/matches/matches.service.js';
import { objectivesService } from '../modules/objectives/index.js';
import { progressionService } from '../modules/progression/progression.service.js';
import { rankedService } from '../modules/ranked/ranked.service.js';
import { rankedAiMatchKey } from './ai-ranked.constants.js';
import {
  deleteMatchCache,
  getMatchCacheOrRebuild,
  setMatchCache,
  type MatchCache,
} from './match-cache.js';
import { lastMatchKey } from './match-keys.js';
import { clearAiMaps, clearHalftimeTimer } from './possession-match-flow.js';
import { getUserIdBySeat, LAST_MATCH_REPLAY_TTL_SEC, type ResolutionDecision } from './possession-state.js';
import { getRedisClient } from './redis.js';
import type { QuizballServer } from './socket-server.js';

export function decideWinner(
  players: Array<{ user_id: string; seat: number; total_points: number }>,
  state: PossessionStatePayload
): ResolutionDecision {
  const seat1UserId = getUserIdBySeat(players, 1);
  const seat2UserId = getUserIdBySeat(players, 2);
  const fallbackWinnerId = seat1UserId ?? seat2UserId ?? players[0]?.user_id ?? null;

  if (state.goals.seat1 > state.goals.seat2) {
    return { winnerId: seat1UserId ?? fallbackWinnerId, method: 'goals', totalPointsFallbackUsed: false };
  }
  if (state.goals.seat2 > state.goals.seat1) {
    return { winnerId: seat2UserId ?? fallbackWinnerId, method: 'goals', totalPointsFallbackUsed: false };
  }

  if (state.penaltyGoals.seat1 > state.penaltyGoals.seat2) {
    return { winnerId: seat1UserId ?? fallbackWinnerId, method: 'penalty_goals', totalPointsFallbackUsed: false };
  }
  if (state.penaltyGoals.seat2 > state.penaltyGoals.seat1) {
    return { winnerId: seat2UserId ?? fallbackWinnerId, method: 'penalty_goals', totalPointsFallbackUsed: false };
  }

  const seat1Points = players.find((player) => player.seat === 1)?.total_points ?? 0;
  const seat2Points = players.find((player) => player.seat === 2)?.total_points ?? 0;

  if (seat1Points > seat2Points) {
    return { winnerId: seat1UserId ?? fallbackWinnerId, method: 'total_points_fallback', totalPointsFallbackUsed: true };
  }
  if (seat2Points > seat1Points) {
    return { winnerId: seat2UserId ?? fallbackWinnerId, method: 'total_points_fallback', totalPointsFallbackUsed: true };
  }

  logger.warn(
    {
      seat1Points,
      seat2Points,
      goals: state.goals,
      penaltyGoals: state.penaltyGoals,
    },
    'Possession winner fallback still tied on total points, selecting seat1 deterministically'
  );
  return { winnerId: fallbackWinnerId, method: 'total_points_fallback', totalPointsFallbackUsed: true };
}

async function flushCacheToDB(cache: MatchCache): Promise<void> {
  await matchesRepo.setMatchStatePayload(cache.matchId, cache.statePayload, cache.currentQIndex);
  await Promise.all(
    cache.players.map((player) =>
      matchesRepo.setPlayerFinalTotals(cache.matchId, player.userId, {
        totalPoints: player.totalPoints,
        correctAnswers: player.correctAnswers,
        goals: player.goals,
        penaltyGoals: player.penaltyGoals,
      })
    )
  );
}

export async function completePossessionMatch(
  io: QuizballServer,
  matchId: string,
  state: PossessionStatePayload,
  preloadedCache?: MatchCache
): Promise<void> {
  const cache = preloadedCache ?? await getMatchCacheOrRebuild(matchId);
  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'active') return;

  const decisionInput = cache
    ? cache.players.map((player) => ({
      user_id: player.userId,
      seat: player.seat,
      total_points: player.totalPoints,
    }))
    : (await matchesRepo.listMatchPlayers(matchId)).map((player) => ({
      user_id: player.user_id,
      seat: player.seat,
      total_points: player.total_points,
    }));
  const decision = decideWinner(decisionInput, state);

  state.phase = 'COMPLETED';
  state.currentQuestion = null;
  state.winnerDecisionMethod = decision.method;

  if (cache) {
    cache.status = 'completed';
    cache.statePayload = state;
    cache.currentQuestion = null;
    cache.answers = {};
    await setMatchCache(cache);
    await flushCacheToDB(cache);
  } else {
    await matchesRepo.setMatchStatePayload(matchId, state, match.current_q_index);
  }

  await matchesRepo.completeMatch(matchId, decision.winnerId);

  const avgTimes = await matchesService.computeAvgTimes(matchId);
  const playerRows = cache
    ? cache.players.map((player) => ({
      user_id: player.userId,
      total_points: player.totalPoints,
      correct_answers: player.correctAnswers,
      goals: player.goals,
      penalty_goals: player.penaltyGoals,
    }))
    : await matchesRepo.listMatchPlayers(matchId);

  for (const player of playerRows) {
    await matchesRepo.updatePlayerAvgTime(matchId, player.user_id, avgTimes.get(player.user_id) ?? null);
  }

  const refreshedPlayers = await matchesRepo.listMatchPlayers(matchId);
  const payloadPlayers: Record<string, {
    totalPoints: number;
    correctAnswers: number;
    avgTimeMs: number | null;
    goals: number;
    penaltyGoals: number;
  }> = {};

  for (const player of refreshedPlayers) {
    payloadPlayers[player.user_id] = {
      totalPoints: player.total_points,
      correctAnswers: player.correct_answers,
      avgTimeMs: player.avg_time_ms,
      goals: player.goals,
      penaltyGoals: player.penalty_goals,
    };
  }

  const durationMs = Date.now() - new Date(cache?.startedAt ?? match.started_at).getTime();
  const resultVersion = Date.now();

  let rankedOutcome = null;
  if (match.mode === 'ranked') {
    logger.info({
      matchId,
      winnerId: decision.winnerId,
      winnerDecisionMethod: decision.method,
      totalPointsFallbackUsed: decision.totalPointsFallbackUsed,
      players: refreshedPlayers.map((player) => ({
        userId: player.user_id,
        totalPoints: player.total_points,
        correctAnswers: player.correct_answers,
        goals: player.goals,
        penaltyGoals: player.penalty_goals,
      })),
    }, 'Finalizing ranked possession match before settlement');
    try {
      rankedOutcome = await rankedService.settleCompletedRankedMatch(matchId);
      logger.info({
        matchId,
        hasOutcome: rankedOutcome != null,
        userIds: rankedOutcome ? Object.keys(rankedOutcome.byUserId) : [],
        outcome: rankedOutcome
          ? Object.values(rankedOutcome.byUserId).map((entry) => ({
            userId: entry.userId,
            oldRp: entry.oldRp,
            newRp: entry.newRp,
            deltaRp: entry.deltaRp,
            placementStatus: entry.placementStatus,
            placementPlayed: entry.placementPlayed,
            placementRequired: entry.placementRequired,
            isPlacement: entry.isPlacement,
          }))
          : [],
      }, 'Ranked settlement result for final_results emit');
    } catch (err) {
      logger.warn({ err, matchId }, 'Ranked settlement failed — emitting results without rankedOutcome');
    }
  }

  try {
    await progressionService.awardCompletedMatchXp(matchId);
  } catch (err) {
    logger.warn({ err, matchId }, 'Match XP award failed after completion');
  }

  const unlockedAchievements = await achievementsService.evaluateForMatch(
    matchId,
    refreshedPlayers.map((player) => player.user_id),
    match.mode === 'ranked' ? 'ranked_sim' : 'friendly_possession'
  );

  try {
    await objectivesService.evaluateForMatchBestEffort(matchId);
  } catch (err) {
    logger.warn({ err, matchId }, 'Objectives evaluation failed after match completion');
  }

  const finalResultsPayload = {
    matchId,
    winnerId: decision.winnerId,
    players: payloadPlayers,
    unlockedAchievements,
    durationMs,
    resultVersion,
    winnerDecisionMethod: decision.method,
    totalPointsFallbackUsed: decision.totalPointsFallbackUsed,
    ...(rankedOutcome ? { rankedOutcome } : {}),
  };

  logger.info({
    matchId,
    hasRankedOutcome: rankedOutcome != null,
    winnerId: decision.winnerId,
    winnerDecisionMethod: decision.method,
    resultVersion,
  }, 'Emitting match:final_results payload');

  io.to(`match:${matchId}`).emit('match:final_results', finalResultsPayload);

  for (const player of refreshedPlayers) {
    const opponentPlayer = refreshedPlayers.find((p) => p.user_id !== player.user_id);
    trackMatchCompleted({
      userId: player.user_id,
      matchId,
      mode: match.mode,
      won: decision.winnerId === player.user_id,
      score: player.total_points,
      opponentScore: opponentPlayer?.total_points ?? 0,
      durationMs,
      goalsFor: player.goals,
      goalsAgainst: opponentPlayer?.goals ?? 0,
      penaltyGoalsFor: player.penalty_goals,
      penaltyGoalsAgainst: opponentPlayer?.penalty_goals ?? 0,
      winnerDecisionMethod: decision.method,
      totalQuestions: cache?.totalQuestions,
      correctAnswers: player.correct_answers,
    });
  }

  if (decision.totalPointsFallbackUsed) {
    trackEvent('match_possession_total_points_fallback_used', decision.winnerId ?? matchId, {
      matchId,
      winnerId: decision.winnerId,
      goals: state.goals,
      penaltyGoals: state.penaltyGoals,
    });
  }

  const redis = getRedisClient();
  if (redis) {
    await redis.del(rankedAiMatchKey(matchId));
    await Promise.all(
      refreshedPlayers.map((player) =>
        redis.set(
          lastMatchKey(player.user_id),
          JSON.stringify({ matchId, resultVersion }),
          { EX: LAST_MATCH_REPLAY_TTL_SEC }
        )
      )
    );
  }

  clearAiMaps(matchId);
  clearHalftimeTimer(matchId);
  await deleteMatchCache(matchId);
}
