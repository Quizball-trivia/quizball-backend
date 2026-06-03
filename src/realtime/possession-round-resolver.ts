import { logger } from '../core/logger.js';
import { matchAnswersRepo } from '../modules/matches/match-answers.repo.js';
import { matchPlayersRepo } from '../modules/matches/match-players.repo.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import { matchesService } from '../modules/matches/matches.service.js';
import { trackPenaltyTaken, trackPossessionPhaseEntered } from '../core/analytics/game-events.js';
import { acquireLock, releaseLock } from './locks.js';
import { matchPauseKey } from './match-keys.js';

/** Regular penalty rounds before sudden-death kicks in. Mirrors the
 *  frontend constant in `features/possession/types/possession.types.ts`. */
const MAX_PENALTY_ROUNDS = 5;
import {
  answerCount,
  buildAnswerPayload,
  countdownGetFound,
  deleteCountdownPlayerKeys,
  getExpectedUserIds,
  getMatchCacheOrRebuild,
  rebuildCacheFromDB,
  setMatchCache,
  type CachedAnswer,
} from './match-cache.js';
import { completePossessionMatch } from './possession-completion.js';
import {
  clearAiAnswerTimer,
  ensureHalftimeCategories,
  fireAndForget,
  scheduleHalftimeTimeout,
  schedulePossessionAiHalftimeBan,
} from './possession-match-flow.js';
import {
  buildPlayersPayloadFromCache,
  getUserIdByCachedSeat,
  selectedIndexForAnswerPersistence,
  toCachedAnswerByUserId,
} from './possession-payload-mappers.js';
import {
  clearQuestionTimer,
  emitMatchState,
  scheduleNextPossessionQuestion,
} from './possession-question-dispatch.js';
import {
  answerLogFields,
  cacheLogFields,
  questionLogFields,
} from './possession-debug-logging.js';
import {
  applyLastAttackResolution,
  applyNormalResolution,
  applyPenaltyResolution,
  resolveSpeedStreak,
} from './possession-resolution.js';
import {
  asSeat,
  bumpStateVersion,
  getQuestionDurationMs,
  type Seat,
} from './possession-state.js';
import { getRedisClient } from './redis.js';
import { calculateCountdownScore } from './scoring.js';
import type { QuizballServer } from './socket-server.js';
import type { MatchRoundResultDeltas } from './socket.types.js';

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
  if (!lock.acquired || !lock.token) {
    logger.warn({ eventName: 'match:round_result', matchId, qIndex, fromTimeout }, 'Possession round resolve skipped: lock busy');
    return;
  }

  try {
    let cache = await getMatchCacheOrRebuild(matchId);
    if (!cache || cache.status !== 'active') {
      logger.warn(
        { eventName: 'match:round_result', matchId, qIndex, fromTimeout, ...cacheLogFields(cache) },
        'Possession round resolve skipped: inactive or missing cache'
      );
      return;
    }
    if (fromTimeout && (cache.currentQIndex !== qIndex || !cache.currentQuestion)) {
      const rebuilt = await rebuildCacheFromDB(matchId);
      if (rebuilt) {
        cache = rebuilt;
        await setMatchCache(rebuilt);
        logger.info(
          { eventName: 'match:round_result', matchId, qIndex, fromTimeout, ...cacheLogFields(cache) },
          'Possession round resolve refreshed cache before timeout resolution'
        );
      }
    }
    if (cache.currentQIndex > qIndex) {
      logger.info(
        { eventName: 'match:round_result', matchId, qIndex, fromTimeout, ...cacheLogFields(cache) },
        'Possession round resolve skipped: qIndex already advanced'
      );
      return;
    }
    if (cache.currentQIndex !== qIndex) {
      logger.warn(
        { eventName: 'match:round_result', matchId, qIndex, fromTimeout, ...cacheLogFields(cache) },
        'Possession round resolve skipped: qIndex mismatch'
      );
      return;
    }

    const question = cache.currentQuestion;
    if (!question) {
      logger.warn(
        { eventName: 'match:round_result', matchId, qIndex, fromTimeout, ...cacheLogFields(cache) },
        'Possession round resolve skipped: missing current question'
      );
      return;
    }

    const pauseStartedAt = await redis.get(matchPauseKey(matchId));
    if (pauseStartedAt) {
      logger.info(
        {
          eventName: 'match:round_result',
          matchId,
          qIndex,
          fromTimeout,
          pauseStartedAt,
          ...cacheLogFields(cache),
          ...questionLogFields(question),
        },
        'Possession round resolve skipped: match paused'
      );
      return;
    }

    const expectedUserIds = getExpectedUserIds(cache);
    if (!fromTimeout && answerCount(cache) < expectedUserIds.length) {
      logger.info(
        {
          matchId,
          eventName: 'match:round_result',
          qIndex,
          fromTimeout,
          answerCount: answerCount(cache),
          expectedCount: expectedUserIds.length,
          expectedUserIds,
          ...questionLogFields(question),
        },
        'Possession round resolve waiting for more answers'
      );
      return;
    }
    logger.info(
      {
        matchId,
        eventName: 'match:round_result',
        qIndex,
        fromTimeout,
        answerCount: answerCount(cache),
        expectedCount: expectedUserIds.length,
        expectedUserIds,
        ...questionLogFields(question),
      },
      'Possession round resolve started'
    );

    if (fromTimeout) {
      const timeoutDurationMs = getQuestionDurationMs(
        question.kind,
        question.evaluation.kind === 'clues' ? question.evaluation.clues.length : undefined
      );
      let backfilledCount = 0;
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
          submittedOrderIds: question.kind === 'putInOrder' ? [] : undefined,
          clueIndex: question.kind === 'clues' ? null : undefined,
        };
        cache.answers[userId] = backfill;
        backfilledCount += 1;
        fireAndForget('insertMatchAnswerIfMissing(timeout)', async () => {
          await matchAnswersRepo.insertMatchAnswerIfMissing({
            matchId,
            qIndex,
            userId,
            selectedIndex: null,
            isCorrect: false,
            timeMs: timeoutDurationMs,
            pointsEarned: 0,
            answerPayload: buildAnswerPayload(backfill),
            phaseKind: question.phaseKind,
            phaseRound: question.phaseRound,
            shooterSeat: question.shooterSeat,
          });
        });
      }
      logger.info(
        {
          matchId,
          eventName: 'match:round_result',
          qIndex,
          timeoutDurationMs,
          backfilledCount,
          expectedCount: expectedUserIds.length,
          ...questionLogFields(question),
        },
        'Possession round timeout backfilled missing answers'
      );
    }

    if (question.kind === 'countdown' && question.evaluation.kind === 'countdown') {
      const totalGroups = question.evaluation.answerGroups.length;
      const seat1UserId = getUserIdByCachedSeat(cache.players, 1);
      const seat2UserId = getUserIdByCachedSeat(cache.players, 2);

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

      logger.info(
        {
          matchId,
          eventName: 'match:round_result',
          qIndex,
          totalGroups,
          seat1UserId,
          seat2UserId,
          seat1FoundCount,
          seat2FoundCount,
          answers: expectedUserIds.map((userId) => ({
            userId,
            ...answerLogFields(cache.answers[userId]),
          })),
          ...questionLogFields(question),
        },
        'Possession countdown round scored'
      );
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
          await matchAnswersRepo.insertMatchAnswerIfMissing({
            matchId,
            qIndex,
            userId: player.userId,
            selectedIndex: selectedIndexForAnswerPersistence(question.kind, answer.selectedIndex),
            isCorrect: answer.isCorrect,
            timeMs: answer.timeMs,
            pointsEarned: answer.pointsEarned,
            answerPayload: buildAnswerPayload(answer),
            phaseKind: question.phaseKind,
            phaseRound: question.phaseRound,
            shooterSeat: question.shooterSeat,
          });
        });
        fireAndForget('updatePlayerTotals(resolve:special)', async () => {
          await matchPlayersRepo.updatePlayerTotals(
            matchId,
            player.userId,
            answer.pointsEarned,
            answer.isCorrect
          );
        });
      }
      logger.info(
        {
          matchId,
          eventName: 'match:round_result',
          qIndex,
          answers: cache.players.map((player) => ({
            userId: player.userId,
            seat: player.seat,
            totalPoints: player.totalPoints,
            correctAnswers: player.correctAnswers,
            ...answerLogFields(cache.answers[player.userId]),
          })),
          ...questionLogFields(question),
        },
        'Possession special answer totals applied'
      );
    }

    const playersPayload = buildPlayersPayloadFromCache(cache);
    const state = cache.statePayload;
    const prevPenGoalsSeat1 = state.penaltyGoals.seat1;
    const prevPenGoalsSeat2 = state.penaltyGoals.seat2;

    const answerByUserId = toCachedAnswerByUserId(cache);
    let possessionDelta = 0;
    let goalScoredBySeat: Seat | null = null;
    let speedStreakBoostedSeat: Seat | null = null;
    // Snapshot before resolution so we can tell if this round crossed a
    // half/phase boundary (which clears the 2× streak) — the preset-second-half
    // path stays in NORMAL_PLAY but bumps the half, so a phase check alone
    // isn't enough.
    const preResolutionHalf = state.half;
    const preResolutionPhase = state.phase;

    if (question.phaseKind === 'normal' || question.phaseKind === 'last_attack') {
      const seat1UserId = getUserIdByCachedSeat(cache.players, 1);
      const seat2UserId = getUserIdByCachedSeat(cache.players, 2);
      const seat1Answer = seat1UserId ? cache.answers[seat1UserId] : undefined;
      const seat2Answer = seat2UserId ? cache.answers[seat2UserId] : undefined;
      const seat1Correct = seat1Answer?.isCorrect ?? false;
      const seat2Correct = seat2Answer?.isCorrect ?? false;
      const seat1BasePoints = seat1UserId ? (seat1Answer?.pointsEarned ?? 0) : 0;
      const seat2BasePoints = seat2UserId ? (seat2Answer?.pointsEarned ?? 0) : 0;
      let seat1Points = seat1BasePoints;
      let seat2Points = seat2BasePoints;

      // 2× speed-streak applies to NORMAL play only: double the *previous*
      // holder's points before computing this round's swing.
      const previousHolderSeat = question.phaseKind === 'normal'
        ? state.speedStreakHolderSeat
        : null;
      const previousCandidateSeat = question.phaseKind === 'normal'
        ? state.speedStreakCandidateSeat
        : null;
      const previousCandidateCount = question.phaseKind === 'normal'
        ? state.speedStreakCandidateCount
        : 0;
      if (previousHolderSeat === 1) seat1Points *= 2;
      else if (previousHolderSeat === 2) seat2Points *= 2;
      if (seat1UserId && playersPayload[seat1UserId]) {
        playersPayload[seat1UserId].possessionPointsEarned = seat1Points;
      }
      if (seat2UserId && playersPayload[seat2UserId]) {
        playersPayload[seat2UserId].possessionPointsEarned = seat2Points;
      }
      // The boost only "fired" if the holder actually earned points to double.
      const boostHadEffect =
        (previousHolderSeat === 1 && seat1BasePoints > 0) ||
        (previousHolderSeat === 2 && seat2BasePoints > 0);

      const result = question.phaseKind === 'normal'
        ? applyNormalResolution(
          state,
          seat1Points,
          seat2Points,
          seat1Correct,
          seat2Correct,
          cache.categoryBId
        )
        : applyLastAttackResolution(state, seat1Points, seat2Points, cache.categoryBId);
      possessionDelta = result.delta;
      goalScoredBySeat = result.goalScoredBySeat;

      // Recompute the streak holder for the next round from THIS round's
      // answers (normal play only). last_attack neither earns nor applies it.
      if (question.phaseKind === 'normal') {
        const streak = resolveSpeedStreak({
          previousHolderSeat: previousHolderSeat,
          previousCandidateSeat,
          previousCandidateCount,
          seat1: { basePoints: seat1BasePoints },
          seat2: { basePoints: seat2BasePoints },
          goalScoredBySeat,
        });
        speedStreakBoostedSeat = boostHadEffect ? streak.boostedSeat : null;
        // Only carry a holder forward if we stayed within the SAME normal-play
        // segment. Any boundary crossing this round — phase change OR a half
        // bump (the preset-second-half path stays NORMAL_PLAY but increments
        // the half) — already cleared the streak; don't resurrect it.
        const stayedInSameSegment =
          state.phase === 'NORMAL_PLAY' &&
          preResolutionPhase === 'NORMAL_PLAY' &&
          state.half === preResolutionHalf;
        state.speedStreakHolderSeat = stayedInSameSegment ? streak.nextHolderSeat : null;
        state.speedStreakCandidateSeat = stayedInSameSegment ? streak.nextCandidateSeat : null;
        state.speedStreakCandidateCount = stayedInSameSegment ? streak.nextCandidateCount : 0;
      }

      logger.info(
        {
          matchId,
          eventName: 'match:round_result',
          qIndex,
          phaseKind: question.phaseKind,
          previousHolderSeat,
          boostHadEffect,
          speedStreakBoostedSeat,
          nextSpeedStreakHolderSeat: state.speedStreakHolderSeat,
          nextSpeedStreakCandidateSeat: state.speedStreakCandidateSeat,
          nextSpeedStreakCandidateCount: state.speedStreakCandidateCount,
          seat1: {
            userId: seat1UserId,
            correct: seat1Correct,
            basePoints: seat1BasePoints,
            resolvedPoints: seat1Points,
            timeMs: seat1Answer?.timeMs ?? null,
          },
          seat2: {
            userId: seat2UserId,
            correct: seat2Correct,
            basePoints: seat2BasePoints,
            resolvedPoints: seat2Points,
            timeMs: seat2Answer?.timeMs ?? null,
          },
          possessionDelta,
          goalScoredBySeat,
          statePhase: state.phase,
          half: state.half,
          ...questionLogFields(question),
        },
        'Possession normal/last-attack resolution computed'
      );
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
      logger.info(
        {
          matchId,
          eventName: 'match:round_result',
          qIndex,
          shooterSeat: asSeat(question.shooterSeat) ?? state.penalty.shooterSeat,
          goalScoredBySeat,
          goalScoredByUserId: penaltyOutcome.goalScoredByUserId,
          statePhase: state.phase,
          penaltyRound: state.penalty.round,
          ...questionLogFields(question),
        },
        'Possession penalty resolution computed'
      );

      // Analytics: per-shooter penalty attempt. `attemptNumber` is the
      // current penalty round; rounds > MAX_PENALTY_ROUNDS are sudden-death.
      try {
        const shooterSeat = asSeat(question.shooterSeat) ?? state.penalty.shooterSeat;
        const shooterUserId = shooterSeat ? getUserIdByCachedSeat(cache.players, shooterSeat) : null;
        if (shooterUserId) {
          trackPenaltyTaken({
            userId: shooterUserId,
            matchId,
            scored: Boolean(penaltyOutcome.goalScoredByUserId),
            attemptNumber: state.penalty.round,
            suddenDeath: state.penalty.round > MAX_PENALTY_ROUNDS,
          });
        }
      } catch (err) {
        logger.warn({ err, matchId }, 'penalty_taken analytics failed');
      }
    }

    state.currentQuestion = null;

    if (goalScoredBySeat) {
      const goalScoredByUserId = getUserIdByCachedSeat(cache.players, goalScoredBySeat);
      const delta = question.phaseKind === 'penalty' ? { penaltyGoals: 1 } : { goals: 1 };
      const MAX_RETRIES = 3;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (goalScoredByUserId) {
            await matchesService.incrementGoalsAndInsertEventIfMissing({
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
      speedStreakBoostedSeat,
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

    logger.info(
      {
        matchId,
        eventName: 'match:round_result',
        qIndex,
        statePhase: state.phase,
        half: state.half,
        possessionDiff: state.possessionDiff,
        goalScoredBySeat: deltas.goalScoredBySeat,
        possessionDelta: deltas.possessionDelta,
        penaltyOutcome: deltas.penaltyOutcome,
        speedStreakHolderSeat: state.speedStreakHolderSeat,
        speedStreakBoostedSeat: deltas.speedStreakBoostedSeat,
        players: Object.entries(playersPayload).map(([userId, player]) => ({
          userId,
          totalPoints: player.totalPoints,
          pointsEarned: player.pointsEarned,
          possessionPointsEarned: player.possessionPointsEarned,
          isCorrect: player.isCorrect,
          selectedIndex: player.selectedIndex,
          timeMs: player.timeMs,
          answer: answerLogFields(cache.answers[userId]),
        })),
        ...questionLogFields(question),
      },
      'Possession round result emitting'
    );
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
      await ensureHalftimeCategories(state, cache.categoryAId, matchId, cache.categoryBId);
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
    logger.info(
      {
        matchId,
        eventName: 'match:state',
        resolvedQIndex: qIndex,
        nextIndex,
        statePhase: state.phase,
        half: state.half,
        possessionDiff: state.possessionDiff,
        speedStreakHolderSeat: state.speedStreakHolderSeat,
        goalScoredBySeat,
      },
      'Possession round advanced state'
    );

    // Analytics: per-player phase transition events.
    // Emit once-per-transition (compare snapshot vs final state). Covers:
    //   first_half → second_half  (half flipped 1 → 2)
    //   * → last_attack            (phase newly LAST_ATTACK)
    //   * → penalty                (phase newly PENALTY_SHOOTOUT)
    if (preResolutionPhase !== state.phase || preResolutionHalf !== state.half) {
      try {
        let phaseLabel: 'first_half' | 'second_half' | 'last_attack' | 'penalty' | null = null;
        if (preResolutionPhase !== 'PENALTY_SHOOTOUT' && state.phase === 'PENALTY_SHOOTOUT') {
          phaseLabel = 'penalty';
        } else if (preResolutionPhase !== 'LAST_ATTACK' && state.phase === 'LAST_ATTACK') {
          phaseLabel = 'last_attack';
        } else if (preResolutionHalf === 1 && state.half === 2) {
          phaseLabel = 'second_half';
        }
        if (phaseLabel) {
          const trackPhase = phaseLabel;
          for (const player of cache.players) {
            trackPossessionPhaseEntered({ userId: player.userId, matchId, phase: trackPhase });
          }
        }
      } catch (err) {
        logger.warn({ err, matchId }, 'possession_phase_entered analytics failed');
      }
    }

    if (state.phase === 'HALFTIME') {
      logger.info({ eventName: 'match:state', matchId, resolvedQIndex: qIndex, nextIndex, half: state.half }, 'Possession match entered halftime');
      scheduleHalftimeTimeout(io, matchId);
      schedulePossessionAiHalftimeBan(io, matchId);
      return;
    }

    if (state.phase === 'COMPLETED') {
      logger.info({ eventName: 'match:state', matchId, resolvedQIndex: qIndex, nextIndex }, 'Possession match completed after round resolve');
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
