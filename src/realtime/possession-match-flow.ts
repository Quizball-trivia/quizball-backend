/**
 * Possession-mode realtime orchestration core.
 *
 * This file wires together the AI, halftime, and round-resolution flows for
 * possession-variant matches. It owns the module-scoped state that the wiring
 * depends on (active question timers, ready-ack gates) and the factory-bound
 * helpers (AI + halftime sub-modules), so it cannot be flattened into pure
 * re-exports without a deeper architectural refactor.
 *
 * The pure helpers (matching, timing, payload mappers, resolution, completion)
 * live in their own sibling modules; the answer handlers and answer-lock
 * utilities also live in dedicated files. This file re-exports those public
 * symbols so external consumers see a single import surface.
 */
import { logger } from '../core/logger.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import { acquireLock, releaseLock } from './locks.js';
import {
  answerCount,
  countdownGetFound,
  deleteCountdownPlayerKeys,
  getExpectedUserIds,
  getMatchCacheOrRebuild,
  setMatchCache,
  type CachedAnswer,
} from './match-cache.js';
import { getRedisClient } from './redis.js';
import type { QuizballServer } from './socket-server.js';
import type {
  MatchRoundResultDeltas,
} from './socket.types.js';
import { calculateCountdownScore } from './scoring.js';

import {
  getQuestionDurationMs,
  type Seat,
  asSeat,
  buildPlayableQuestionTiming,
  parsePossessionState,
  bumpStateVersion,
} from './possession-state.js';

import { createPossessionAi } from './possession-ai.js';
import { createPossessionHalftime } from './possession-halftime.js';
import {
  clueIndexForTimeMs,
  countdownMatch,
  normalizeAnswer,
} from './possession-answer-matching.js';
import {
  computeAuthoritativeTimeMs,
  computeResumedPossessionTiming,
} from './possession-timing.js';
import {
  buildPlayersPayloadFromCache,
  getUserIdByCachedSeat,
  questionTypeForState,
  selectedIndexForAnswerPersistence,
  toCachedAnswerByUserId,
} from './possession-payload-mappers.js';
import {
  applyDeltaAndGoalCheck,
  applyLastAttackResolution,
  applyNormalResolution,
  applyPenaltyResolution,
  categoryIdsForCurrentHalf,
  penaltyWinnerSeat,
} from './possession-resolution.js';
import { completePossessionMatch, decideWinner } from './possession-completion.js';
import {
  clearQuestionTimer,
  emitMatchState,
  emitPossessionStateToSocket,
  handlePossessionReadyForNextQuestion,
  resumePossessionMatchQuestion,
  scheduleNextPossessionQuestion,
  sendPossessionMatchQuestion,
} from './possession-question-dispatch.js';
export {
  clearQuestionTimer,
  emitMatchState,
  emitPossessionStateToSocket,
  handlePossessionReadyForNextQuestion,
  resumePossessionMatchQuestion,
  scheduleNextPossessionQuestion,
  sendPossessionMatchQuestion,
};

export async function handlePossessionHalftimeUiReady(
  io: QuizballServer,
  userId: string,
  matchId: string
): Promise<void> {
  await handlePossessionHalftimeUiReadyInternal(io, userId, matchId);
}

// ── Initialize AI sub-module ──
// Forward declaration resolved: resolvePossessionRound is defined below and passed as callback.
const possessionAi = createPossessionAi(
  (io, matchId, qIndex, isTimeout) => resolvePossessionRound(io, matchId, qIndex, isTimeout)
);
const {
  resolveAiUserIdForMatch,
  schedulePossessionAiAnswer,
  clearAiAnswerTimer,
  clearAiMaps,
} = possessionAi;

// ── Initialize Halftime sub-module ──
const possessionHalftime = createPossessionHalftime({
  sendQuestion: (io, matchId, qIndex, opts) => sendPossessionMatchQuestion(io, matchId, qIndex, opts),
  resolveAiUserId: (matchId) => resolveAiUserIdForMatch(matchId),
});
const {
  clearHalftimeTimer,
  getHalftimeTurnSeat,
  ensureHalftimeCategories,
  resolveHalftimeResult,
  scheduleFinalizeHalftime,
  scheduleHalftimeTimeout,
  schedulePossessionAiHalftimeBan,
  handlePossessionHalftimeUiReady: handlePossessionHalftimeUiReadyInternal,
} = possessionHalftime;

export {
  clearAiAnswerTimer,
  clearAiMaps,
  clearHalftimeTimer,
  ensureHalftimeCategories,
  getHalftimeTurnSeat,
  resolveAiUserIdForMatch,
  scheduleFinalizeHalftime,
  scheduleHalftimeTimeout,
  schedulePossessionAiAnswer,
  schedulePossessionAiHalftimeBan,
};


export function fireAndForget(label: string, fn: () => Promise<unknown>): void {
  fn().catch((error) => {
    logger.error({ error, label }, 'Fire-and-forget DB write failed');
  });
}

export async function resolvePossessionRound(
  io: QuizballServer,
  matchId: string,
  qIndex: number,
  fromTimeout = false
): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) {
    logger.error({ matchId, qIndex }, 'Cannot resolve possession round — Redis unavailable');
    return;
  }

  const lockKey = `lock:match:${matchId}:resolve`;
  const lock = await acquireLock(lockKey, 5000);
  if (!lock.acquired || !lock.token) return;

  try {
    const cache = await getMatchCacheOrRebuild(matchId);
    if (!cache || cache.status !== 'active') return;
    if (cache.currentQIndex > qIndex) return;
    if (cache.currentQIndex !== qIndex) return;

    const question = cache.currentQuestion;
    if (!question) return;

    const expectedUserIds = getExpectedUserIds(cache);
    if (!fromTimeout && answerCount(cache) < expectedUserIds.length) {
      return;
    }

    if (fromTimeout) {
      const timeoutDurationMs = getQuestionDurationMs(
        question.kind,
        question.evaluation.kind === 'clues' ? question.evaluation.clues.length : undefined
      );
      for (const userId of expectedUserIds) {
        if (cache.answers[userId]) continue;
        const backfill: CachedAnswer = {
          userId,
          questionKind: question.kind,
          selectedIndex: null,
          isCorrect: false,
          timeMs: timeoutDurationMs,
          pointsEarned: 0,
          phaseKind: question.phaseKind,
          phaseRound: question.phaseRound,
          shooterSeat: question.shooterSeat,
          answeredAt: new Date().toISOString(),
          foundCount: question.kind === 'countdown' || question.kind === 'putInOrder' ? 0 : undefined,
          foundAnswerIds: question.kind === 'countdown' ? [] : undefined,
          clueIndex: question.kind === 'clues' ? null : undefined,
        };
        cache.answers[userId] = backfill;
        fireAndForget('insertMatchAnswerIfMissing(timeout)', async () => {
          await matchesRepo.insertMatchAnswerIfMissing({
            matchId,
            qIndex,
            userId,
            selectedIndex: null,
            isCorrect: false,
            timeMs: timeoutDurationMs,
            pointsEarned: 0,
            phaseKind: question.phaseKind,
            phaseRound: question.phaseRound,
            shooterSeat: question.shooterSeat,
          });
        });
      }
    }

    if (question.kind === 'countdown' && question.evaluation.kind === 'countdown') {
      const totalGroups = question.evaluation.answerGroups.length;
      const seat1UserId = getUserIdByCachedSeat(cache.players, 1);
      const seat2UserId = getUserIdByCachedSeat(cache.players, 2);

      // Merge per-player Redis Sets into cache answers for resolution.
      const playerFoundIdsList = await Promise.all(
        expectedUserIds.map((userId) => countdownGetFound(matchId, userId))
      );
      for (const [index, userId] of expectedUserIds.entries()) {
        const playerFoundIds = playerFoundIdsList[index] ?? [];
        const answer = cache.answers[userId] ?? {
          userId,
          questionKind: 'countdown' as const,
          selectedIndex: 0,
          isCorrect: false,
          timeMs: getQuestionDurationMs(question.kind),
          pointsEarned: 0,
          phaseKind: question.phaseKind,
          phaseRound: question.phaseRound,
          shooterSeat: question.shooterSeat,
          answeredAt: new Date().toISOString(),
          foundCount: 0,
          foundAnswerIds: [],
        };
        answer.foundAnswerIds = playerFoundIds;
        answer.foundCount = playerFoundIds.length;
        answer.selectedIndex = playerFoundIds.length;
        answer.pointsEarned = calculateCountdownScore(playerFoundIds.length, totalGroups);
        cache.answers[userId] = answer;
      }

      const seat1FoundCount = seat1UserId ? cache.answers[seat1UserId]?.foundCount ?? 0 : 0;
      const seat2FoundCount = seat2UserId ? cache.answers[seat2UserId]?.foundCount ?? 0 : 0;

      for (const userId of expectedUserIds) {
        const answer = cache.answers[userId];
        if (!answer) continue;
        answer.isCorrect = userId === seat1UserId
          ? (answer.foundCount ?? 0) > seat2FoundCount
          : (answer.foundCount ?? 0) > seat1FoundCount;
      }

      // Clean up per-player countdown keys after merging.
      await deleteCountdownPlayerKeys(matchId, expectedUserIds);
    }

    if (question.kind !== 'multipleChoice') {
      for (const player of cache.players) {
        const answer = cache.answers[player.userId];
        if (!answer) continue;

        player.totalPoints += answer.pointsEarned;
        if (answer.isCorrect) {
          player.correctAnswers += 1;
        }

        fireAndForget('insertMatchAnswerIfMissing(resolve:special)', async () => {
          await matchesRepo.insertMatchAnswerIfMissing({
            matchId,
            qIndex,
            userId: player.userId,
            selectedIndex: selectedIndexForAnswerPersistence(question.kind, answer.selectedIndex),
            isCorrect: answer.isCorrect,
            timeMs: answer.timeMs,
            pointsEarned: answer.pointsEarned,
            phaseKind: question.phaseKind,
            phaseRound: question.phaseRound,
            shooterSeat: question.shooterSeat,
          });
        });
        fireAndForget('updatePlayerTotals(resolve:special)', async () => {
          await matchesRepo.updatePlayerTotals(
            matchId,
            player.userId,
            answer.pointsEarned,
            answer.isCorrect
          );
        });
      }
    }

    const playersPayload = buildPlayersPayloadFromCache(cache);
    const state = cache.statePayload;
    const prevPenGoalsSeat1 = state.penaltyGoals.seat1;
    const prevPenGoalsSeat2 = state.penaltyGoals.seat2;

    const answerByUserId = toCachedAnswerByUserId(cache);
    let possessionDelta = 0;
    let goalScoredBySeat: Seat | null = null;

    if (question.phaseKind === 'normal' || question.phaseKind === 'last_attack') {
      const seat1UserId = getUserIdByCachedSeat(cache.players, 1);
      const seat2UserId = getUserIdByCachedSeat(cache.players, 2);
      const seat1Answer = seat1UserId
        ? cache.answers[seat1UserId]
        : undefined;
      const seat2Answer = seat2UserId
        ? cache.answers[seat2UserId]
        : undefined;
      const seat1Points = seat1UserId
        ? (seat1Answer?.pointsEarned ?? 0)
        : 0;
      const seat2Points = seat2UserId
        ? (seat2Answer?.pointsEarned ?? 0)
        : 0;
      const result = question.phaseKind === 'normal'
        ? applyNormalResolution(
          state,
          seat1Points,
          seat2Points,
          seat1Answer?.isCorrect ?? false,
          seat2Answer?.isCorrect ?? false,
          cache.categoryBId
        )
        : applyLastAttackResolution(state, seat1Points, seat2Points, cache.categoryBId);
      possessionDelta = result.delta;
      goalScoredBySeat = result.goalScoredBySeat;
      if (result.goalScoredBySeat) {
        const scorerUserId = getUserIdByCachedSeat(cache.players, result.goalScoredBySeat);
        const scorer = scorerUserId ? cache.players.find((player) => player.userId === scorerUserId) : null;
        if (scorer) scorer.goals += 1;
      }
    } else {
      const penaltyOutcome = applyPenaltyResolution(
        state,
        cache.players,
        answerByUserId,
        asSeat(question.shooterSeat) ?? state.penalty.shooterSeat
      );
      if (penaltyOutcome.goalScoredByUserId) {
        const scorer = cache.players.find((player) => player.userId === penaltyOutcome.goalScoredByUserId);
        goalScoredBySeat = scorer?.seat ?? null;
      }
    }

    state.currentQuestion = null;

    if (goalScoredBySeat) {
      const goalScoredByUserId = getUserIdByCachedSeat(cache.players, goalScoredBySeat);
      const delta = question.phaseKind === 'penalty' ? { penaltyGoals: 1 } : { goals: 1 };
      const MAX_RETRIES = 3;
      // The atomic write (insert event + increment totals in one tx) is now
      // naturally idempotent — on retry the ON CONFLICT short-circuits and the
      // totals aren't incremented again. No local flag needed.
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (goalScoredByUserId) {
            await matchesRepo.incrementGoalsAndInsertEventIfMissing({
              matchId,
              userId: goalScoredByUserId,
              seat: goalScoredBySeat,
              half: state.half,
              phaseKind: question.phaseKind,
              qIndex,
              isPenalty: question.phaseKind === 'penalty',
              delta,
            });
          }
          break;
        } catch (err) {
          if (attempt === MAX_RETRIES) {
            logger.error(
              { error: err, matchId, userId: goalScoredByUserId, delta, phaseKind: question.phaseKind },
              'incrementGoalsAndInsertEventIfMissing failed after retries'
            );
            break;
          }
          await new Promise((r) => setTimeout(r, 100 * 2 ** (attempt - 1)));
        }
      }
    }

    const deltas: MatchRoundResultDeltas = {
      possessionDelta,
      penaltyOutcome: null,
      goalScoredBySeat,
    };

    if (question.phaseKind === 'penalty') {
      const penDiff1 = state.penaltyGoals.seat1 - prevPenGoalsSeat1;
      const penDiff2 = state.penaltyGoals.seat2 - prevPenGoalsSeat2;
      if (penDiff1 > 0 || penDiff2 > 0) {
        deltas.penaltyOutcome = 'goal';
        deltas.goalScoredBySeat = penDiff1 > 0 ? 1 : 2;
      } else {
        deltas.penaltyOutcome = 'saved';
      }
    }

    io.to(`match:${matchId}`).emit('match:round_result', {
      matchId,
      qIndex,
      questionKind: question.kind,
      reveal: question.reveal,
      players: playersPayload,
      phaseKind: question.phaseKind,
      phaseRound: question.phaseRound,
      shooterSeat: question.shooterSeat,
      attackerSeat: question.attackerSeat,
      deltas,
    });

    if (state.phase === 'HALFTIME') {
      await ensureHalftimeCategories(state, cache.categoryAId, matchId);
    }

    const nextIndex = qIndex + 1;
    cache.currentQIndex = nextIndex;
    cache.currentQuestion = null;
    cache.answers = {};
    bumpStateVersion(state);

    await setMatchCache(cache);
    fireAndForget('setMatchStatePayload(resolve)', async () => {
      await matchesRepo.setMatchStatePayload(matchId, state, nextIndex);
    });
    await emitMatchState(io, matchId, state);

    if (state.phase === 'HALFTIME') {
      scheduleHalftimeTimeout(io, matchId);
      schedulePossessionAiHalftimeBan(io, matchId);
      return;
    }

    if (state.phase === 'COMPLETED') {
      await completePossessionMatch(io, matchId, state, cache);
      return;
    }

    await scheduleNextPossessionQuestion(io, matchId, cache, {
      phase: state.phase,
      phaseKind: question.phaseKind,
      resolvedQIndex: qIndex,
      nextIndex,
      goalScoredBySeat,
    });
  } finally {
    await releaseLock(lockKey, lock.token);
    clearQuestionTimer(matchId, qIndex);
    clearAiAnswerTimer(matchId, qIndex);
  }
}

export {
  handlePossessionAnswer,
  handlePossessionChanceCardUse,
  handlePossessionCluesAnswer,
  handlePossessionCountdownGuess,
  handlePossessionPutInOrderAnswer,
} from './possession-answer-handlers.js';

export { devSkipToPossessionPhase } from './possession-dev-skip.js';
export { handlePossessionHalftimeBan } from './possession-halftime-ban.js';

export function cancelPossessionQuestionTimer(matchId: string, qIndex: number): void {
  clearQuestionTimer(matchId, qIndex);
  clearAiAnswerTimer(matchId, qIndex);
}

export function cancelPossessionHalftimeTimer(matchId: string): void {
  clearHalftimeTimer(matchId);
  clearAiMaps(matchId);
}

export const __possessionInternals = {
  parsePossessionState,
  categoryIdsForCurrentHalf,
  questionTypeForState,
  buildPlayableQuestionTiming,
  computeResumedPossessionTiming,
  clueIndexForTimeMs,
  computeAuthoritativeTimeMs,
  applyDeltaAndGoalCheck,
  applyNormalResolution,
  applyLastAttackResolution,
  resolveHalftimeResult,
  penaltyWinnerSeat,
  decideWinner,
  normalizeAnswer,
  countdownMatch,
  selectedIndexForAnswerPersistence,
};
