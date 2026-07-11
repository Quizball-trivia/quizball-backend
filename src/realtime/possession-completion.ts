import { trackEvent } from '../core/analytics.js';
import { trackMatchCompleted } from '../core/analytics/game-events.js';
import { logger } from '../core/logger.js';
import { matchAnswersRepo } from '../modules/matches/match-answers.repo.js';
import { matchPlayersRepo } from '../modules/matches/match-players.repo.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import { usersRepo } from '../modules/users/users.repo.js';
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
import { acquireLock, releaseLock, startLockHeartbeat } from './locks.js';
import { clearAiMaps, clearHalftimeTimer, fireAndForget } from './possession-match-flow.js';
import {
  getUserIdBySeat,
  LAST_MATCH_REPLAY_TTL_SEC,
  parsePossessionState,
  type ResolutionDecision,
} from './possession-state.js';
import { getRedisClient } from './redis.js';
import {
  buildFinalResultsPayload,
  emitFinalResultsToMatchParticipants,
} from './services/match-final-results.service.js';
import { finalizeRankedNoContest } from './services/ranked-no-contest.service.js';
import { hasNoHumanInteraction } from './services/match-interaction.service.js';
import type { QuizballServer } from './socket-server.js';
import type { MatchFinalResultsPayload } from './socket.types.js';

type QuestionResult = NonNullable<MatchFinalResultsPayload['questionResults']>[string][number];
export type ProgressDecisionBasis = 'goals' | 'penalty_goals' | 'total_points' | 'correct_answers';
export type ProgressResolutionDecision = ResolutionDecision & { basis: ProgressDecisionBasis };

export interface CompletePossessionMatchResult {
  matchId: string;
  winnerId: string | null;
  resultVersion: number;
  completed: boolean;
  reason?: 'lock_not_acquired' | 'not_active' | 'undecidable';
  decisionBasis?: ProgressDecisionBasis | 'natural';
}

type CompletionDecision = ResolutionDecision & {
  basis?: ProgressDecisionBasis | 'natural';
};

type CompletePossessionMatchOptions = {
  decisionStrategy?: 'natural' | 'progress';
  source?: string;
};

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

export function decideWinnerFromProgress(
  players: Array<{ user_id: string; seat: number; total_points: number; correct_answers: number }>,
  state: PossessionStatePayload
): ProgressResolutionDecision | null {
  const seat1UserId = getUserIdBySeat(players, 1);
  const seat2UserId = getUserIdBySeat(players, 2);
  if (!seat1UserId || !seat2UserId) return null;

  if (state.goals.seat1 > state.goals.seat2) {
    return { winnerId: seat1UserId, method: 'goals', totalPointsFallbackUsed: false, basis: 'goals' };
  }
  if (state.goals.seat2 > state.goals.seat1) {
    return { winnerId: seat2UserId, method: 'goals', totalPointsFallbackUsed: false, basis: 'goals' };
  }

  if (state.penaltyGoals.seat1 > state.penaltyGoals.seat2) {
    return { winnerId: seat1UserId, method: 'penalty_goals', totalPointsFallbackUsed: false, basis: 'penalty_goals' };
  }
  if (state.penaltyGoals.seat2 > state.penaltyGoals.seat1) {
    return { winnerId: seat2UserId, method: 'penalty_goals', totalPointsFallbackUsed: false, basis: 'penalty_goals' };
  }

  const seat1 = players.find((player) => player.seat === 1);
  const seat2 = players.find((player) => player.seat === 2);
  const seat1Points = seat1?.total_points ?? 0;
  const seat2Points = seat2?.total_points ?? 0;
  if (seat1Points > seat2Points) {
    return { winnerId: seat1UserId, method: 'total_points_fallback', totalPointsFallbackUsed: true, basis: 'total_points' };
  }
  if (seat2Points > seat1Points) {
    return { winnerId: seat2UserId, method: 'total_points_fallback', totalPointsFallbackUsed: true, basis: 'total_points' };
  }

  const seat1Correct = seat1?.correct_answers ?? 0;
  const seat2Correct = seat2?.correct_answers ?? 0;
  if (seat1Correct > seat2Correct) {
    // Public result enums stay unchanged; logs/basis expose that this was
    // actually decided by correct answers, not by total points.
    return { winnerId: seat1UserId, method: 'total_points_fallback', totalPointsFallbackUsed: true, basis: 'correct_answers' };
  }
  if (seat2Correct > seat1Correct) {
    // Public result enums stay unchanged; logs/basis expose that this was
    // actually decided by correct answers, not by total points.
    return { winnerId: seat2UserId, method: 'total_points_fallback', totalPointsFallbackUsed: true, basis: 'correct_answers' };
  }

  return null;
}

async function flushCacheToDB(cache: MatchCache): Promise<void> {
  await matchesRepo.setMatchStatePayload(cache.matchId, cache.statePayload, cache.currentQIndex);
  await Promise.all(
    cache.players.map((player) =>
      matchPlayersRepo.setPlayerFinalTotals(cache.matchId, player.userId, {
        totalPoints: player.totalPoints,
        correctAnswers: player.correctAnswers,
        goals: player.goals,
        penaltyGoals: player.penaltyGoals,
      })
    )
  );
}

async function buildFinalQuestionResults(
  matchId: string,
  userIds: string[],
  totalQuestions: number
): Promise<NonNullable<MatchFinalResultsPayload['questionResults']>> {
  const safeTotal = Math.max(0, totalQuestions);
  const results = Object.fromEntries(
    userIds.map((userId) => [
      userId,
      Array.from({ length: safeTotal }, () => null as QuestionResult),
    ])
  ) as NonNullable<MatchFinalResultsPayload['questionResults']>;

  if (safeTotal === 0) return results;

  const answers = await matchAnswersRepo.listAnswersForMatch(matchId);
  for (const answer of answers) {
    const playerResults = results[answer.user_id];
    if (!playerResults) continue;
    const answerQIndex = answer.q_index;
    if (answerQIndex < 0 || answerQIndex >= safeTotal) continue;
    playerResults[answerQIndex] = answer.is_correct ? 'correct' : 'wrong';
  }

  return results;
}

export async function completePossessionMatch(
  io: QuizballServer,
  matchId: string,
  state: PossessionStatePayload,
  preloadedCache?: MatchCache,
  options: CompletePossessionMatchOptions = {}
): Promise<CompletePossessionMatchResult> {
  const lockKey = `lock:match:${matchId}:complete`;
  const lockTtlMs = 15_000;
  const lock = await acquireLock(lockKey, lockTtlMs);
  if (!lock.acquired || !lock.token) {
    return { matchId, winnerId: null, resultVersion: Date.now(), completed: false, reason: 'lock_not_acquired' };
  }
  // Keep the lock alive for the full critical section (settlement, XP, objectives,
  // avg-times, emits) so a slow >TTL run can't expire it and let a second resolver
  // duplicate completion.
  const heartbeat = startLockHeartbeat(lockKey, lock.token, lockTtlMs);

  try {
    const [cache, match] = await Promise.all([
      preloadedCache ? Promise.resolve(preloadedCache) : getMatchCacheOrRebuild(matchId),
      matchesRepo.getMatch(matchId),
    ]);
    if (!match || match.status !== 'active') {
      return { matchId, winnerId: null, resultVersion: Date.now(), completed: false, reason: 'not_active' };
    }

    const completionState = options.decisionStrategy === 'progress'
      ? cache?.statePayload ?? parsePossessionState(match.state_payload)
      : state;

    const decisionInput = cache
      ? cache.players.map((player) => ({
        user_id: player.userId,
        seat: player.seat,
        total_points: player.totalPoints,
        correct_answers: player.correctAnswers,
      }))
      : (await matchPlayersRepo.listMatchPlayers(matchId)).map((player) => ({
        user_id: player.user_id,
        seat: player.seat,
        total_points: player.total_points,
        correct_answers: player.correct_answers,
      }));
    const decision: CompletionDecision | null = options.decisionStrategy === 'progress'
      ? decideWinnerFromProgress(decisionInput, completionState)
      : { ...decideWinner(decisionInput, completionState), basis: 'natural' };
    if (!decision) {
      logger.info(
        {
          matchId,
          source: options.source ?? null,
          goals: completionState.goals,
          penaltyGoals: completionState.penaltyGoals,
          players: decisionInput.map((player) => ({
            userId: player.user_id,
            seat: player.seat,
            totalPoints: player.total_points,
            correctAnswers: player.correct_answers,
          })),
        },
        'Progress completion skipped because match progress is undecidable'
      );
      return { matchId, winnerId: null, resultVersion: Date.now(), completed: false, reason: 'undecidable' };
    }

    // Zero-interaction no-contest safety net: a ghost ranked match where BOTH
    // clients were gone plays out entirely on round timeouts (every answer
    // backfilled) via the natural round-resolver path and would otherwise
    // finalize with a real winner, costing an innocent player RP. If no human
    // ever genuinely submitted an answer, void it as a no-contest instead of
    // applying the fabricated result. One-sided matches (a human who actually
    // played beating an absent opponent) are NOT voided — a single genuine
    // submission clears this guard.
    //
    // Scoped to the NATURAL completion strategy only: the progress strategy
    // (grace expiry / orphan resolver / disconnect) already owns forfeit-first
    // and its own no-contest+refund handling, and must keep completing by
    // existing progress (S15b) — this guard must not intercept that path.
    if (match.mode === 'ranked' && options.decisionStrategy !== 'progress') {
      const rosterUsers = await usersRepo.getByIds(decisionInput.map((player) => player.user_id));
      const humanUserIds = new Set(
        decisionInput
          .map((player) => rosterUsers.get(player.user_id))
          .filter((user): user is NonNullable<typeof user> => user != null && user.is_ai === false)
          .map((user) => user.id)
      );
      if (humanUserIds.size > 0) {
        const answers = await matchAnswersRepo.listAnswersForMatch(matchId);
        if (hasNoHumanInteraction(answers, humanUserIds)) {
          const resultVersion = await finalizeRankedNoContest({
            matchId,
            roster: decisionInput.map((player) => ({ user_id: player.user_id })),
            statePayload: completionState as unknown as Record<string, unknown>,
            roundsPlayed: cache?.currentQIndex ?? match.current_q_index,
          });
          logger.info(
            { matchId, roundsPlayed: cache?.currentQIndex ?? match.current_q_index },
            'Ranked match cancelled as no-contest (zero human interaction) — RP unchanged, tickets refunded'
          );
          clearAiMaps(matchId);
          clearHalftimeTimer(matchId);
          const finalPayload = await buildFinalResultsPayload(matchId, resultVersion);
          if (finalPayload) {
            await emitFinalResultsToMatchParticipants(io, matchId, finalPayload);
          }
          return {
            matchId,
            winnerId: null,
            resultVersion,
            completed: true,
          };
        }
      }
    }

    completionState.phase = 'COMPLETED';
    completionState.currentQuestion = null;
    completionState.winnerDecisionMethod = decision.method;

    if (cache) {
      cache.status = 'completed';
      cache.statePayload = completionState;
      cache.currentQuestion = null;
      cache.answers = {};
      cache.revealAcks = {};
      await setMatchCache(cache);
      await flushCacheToDB(cache);
    } else {
      await matchesRepo.setMatchStatePayload(matchId, completionState, match.current_q_index);
    }

    await matchesService.completeMatch(matchId, decision.winnerId);

    const [avgTimes, playerRows] = await Promise.all([
      matchesService.computeAvgTimes(matchId),
      cache
        ? Promise.resolve(cache.players.map((player) => ({
          user_id: player.userId,
          total_points: player.totalPoints,
          correct_answers: player.correctAnswers,
          goals: player.goals,
          penalty_goals: player.penaltyGoals,
        })))
        : matchPlayersRepo.listMatchPlayers(matchId),
    ]);
    const finalPlayers = playerRows.map((player) => ({
      ...player,
      avg_time_ms: avgTimes.get(player.user_id) ?? null,
    }));

    await Promise.all(
      finalPlayers.map((player) =>
        matchPlayersRepo.updatePlayerAvgTime(matchId, player.user_id, player.avg_time_ms)
      )
    );

    const payloadPlayers: Record<string, {
      totalPoints: number;
      correctAnswers: number;
      avgTimeMs: number | null;
      goals: number;
      penaltyGoals: number;
    }> = {};

    for (const player of finalPlayers) {
      payloadPlayers[player.user_id] = {
        totalPoints: player.total_points,
        correctAnswers: player.correct_answers,
        avgTimeMs: player.avg_time_ms,
        goals: player.goals,
        penaltyGoals: player.penalty_goals,
      };
    }

    let questionResults: MatchFinalResultsPayload['questionResults'];
    try {
      questionResults = await buildFinalQuestionResults(
        matchId,
        finalPlayers.map((player) => player.user_id),
        match.total_questions
      );
    } catch (err) {
      logger.warn({ err, matchId }, 'Failed to build final question results');
    }

    const durationMs = Date.now() - new Date(cache?.startedAt ?? match.started_at).getTime();
    const resultVersion = Date.now();

    let rankedOutcome = null;
    if (match.mode === 'ranked') {
      logger.info({
        matchId,
        source: options.source ?? null,
        winnerId: decision.winnerId,
        winnerDecisionMethod: decision.method,
        decisionBasis: decision.basis ?? 'natural',
        correctAnswersFallbackMappedToTotalPointsFallback: decision.basis === 'correct_answers',
        totalPointsFallbackUsed: decision.totalPointsFallbackUsed,
        players: finalPlayers.map((player) => ({
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

    const completionSideEffectsStartedAt = Date.now();
    let unlockedAchievements: NonNullable<MatchFinalResultsPayload['unlockedAchievements']> = {};
    const [xpAwardResult, achievementResult] = await Promise.allSettled([
      progressionService.awardCompletedMatchXp(matchId),
      achievementsService.evaluateForMatch(
        matchId,
        finalPlayers.map((player) => player.user_id),
        match.mode === 'ranked' ? 'ranked_sim' : 'friendly_possession'
      ),
    ]);
    if (xpAwardResult.status === 'rejected') {
      logger.warn({ err: xpAwardResult.reason, matchId }, 'Match XP award failed after completion');
    }
    if (achievementResult.status === 'fulfilled') {
      unlockedAchievements = achievementResult.value;
    } else {
      logger.warn(
        { err: achievementResult.reason, matchId },
        'Achievement evaluation failed after completion'
      );
    }

    const finalResultsPayload = {
      matchId,
      winnerId: decision.winnerId,
      players: payloadPlayers,
      totalQuestions: match.total_questions,
      ...(questionResults ? { questionResults } : {}),
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
      decisionBasis: decision.basis ?? 'natural',
      resultVersion,
      sideEffectsMs: Date.now() - completionSideEffectsStartedAt,
    }, 'Emitting match:final_results payload');

    const redis = getRedisClient();
    // The AI-match key stores the AI opponent's user id (set when an AI ranked
    // match is created). Read it before deleting so we can tag analytics with
    // whether each player faced an AI. AI users have real UUIDs, so this Redis
    // key is the only reliable AI signal here.
    let aiOpponentUserId: string | null = null;
    if (redis) {
      aiOpponentUserId = await redis.get(rankedAiMatchKey(matchId));
      await redis.del(rankedAiMatchKey(matchId));
      await Promise.all(
        finalPlayers.map((player) =>
          redis.set(
            lastMatchKey(player.user_id),
            JSON.stringify({ matchId, resultVersion }),
            { EX: LAST_MATCH_REPLAY_TTL_SEC }
          )
        )
      );
    }

    io.to(`match:${matchId}`).emit('match:final_results', finalResultsPayload);

    fireAndForget('evaluateObjectivesAfterPossessionFinalResults', async () => {
      await objectivesService.evaluateForMatchBestEffort(matchId);
    });

    for (const player of finalPlayers) {
      const opponentPlayer = finalPlayers.find((p) => p.user_id !== player.user_id);
      // Skip the AI's own row — it has no browser and shouldn't count as a player.
      if (aiOpponentUserId && player.user_id === aiOpponentUserId) continue;
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
        opponentIsAi: aiOpponentUserId != null && opponentPlayer?.user_id === aiOpponentUserId,
      });
    }

    if (decision.totalPointsFallbackUsed) {
      trackEvent('match_possession_total_points_fallback_used', decision.winnerId ?? matchId, {
        matchId,
        winnerId: decision.winnerId,
        decisionBasis: decision.basis ?? 'natural',
        correctAnswersFallbackMappedToTotalPointsFallback: decision.basis === 'correct_answers',
        goals: completionState.goals,
        penaltyGoals: completionState.penaltyGoals,
      });
    }

    clearAiMaps(matchId);
    clearHalftimeTimer(matchId);
    await deleteMatchCache(matchId);
    return {
      matchId,
      winnerId: decision.winnerId,
      resultVersion,
      completed: true,
      decisionBasis: decision.basis ?? 'natural',
    };
  } finally {
    heartbeat.stop();
    await releaseLock(lockKey, lock.token);
  }
}

export async function completePossessionMatchFromProgress(
  io: QuizballServer,
  matchId: string,
  source: string
): Promise<CompletePossessionMatchResult> {
  return completePossessionMatch(
    io,
    matchId,
    parsePossessionState(null),
    undefined,
    { decisionStrategy: 'progress', source }
  );
}
