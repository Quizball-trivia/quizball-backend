import { logger } from '../core/logger.js';
import { appMetrics } from '../core/metrics.js';
import { withSpan } from '../core/tracing.js';
import { matchQuestionsRepo } from '../modules/matches/match-questions.repo.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import {
  matchesService,
  POSSESSION_QUESTIONS_PER_HALF,
  type PossessionStatePayload,
} from '../modules/matches/matches.service.js';
import { questionPayloadSchema, type QuestionType } from '../modules/questions/questions.schemas.js';
import {
  countdownGetFound,
  getMatchCacheOrRebuild,
  setMatchCache,
  type MatchCache,
} from './match-cache.js';
import { matchPauseKey, questionTimerKey } from './match-keys.js';
import { harnessDelayMs } from '../core/harness-timing.js';
import { cancelRealtimeTimer, hasPendingRealtimeTimer, scheduleRealtimeTimer } from './realtime-timer-scheduler.js';
import {
  ensureHalftimeCategories,
  fireAndForget,
  resolveAiUserIdForMatch,
  resolvePossessionRound,
  scheduleHalftimeTimeout,
  schedulePossessionAiAnswer,
  schedulePossessionAiHalftimeBan,
} from './possession-match-flow.js';
import { HALFTIME_DURATION_MS } from './possession-halftime.js';
import {
  answerLogFields,
  cacheLogFields,
  questionLogFields,
} from './possession-debug-logging.js';
import {
  buildCachedAnswerAckPayload,
  questionKindForType,
  questionTypeForState,
} from './possession-payload-mappers.js';
import { categoryIdsForCurrentHalf } from './possession-resolution.js';
import {
  buildPlayableQuestionTiming,
  bumpStateVersion,
  FRONTEND_GOAL_CELEBRATION_MS,
  FRONTEND_RESULT_HOLD_MS,
  FRONTEND_TRANSITION_DELAY_MS,
  getDifficultyForState,
  parsePossessionState,
  phaseKindFromState,
  TIMEOUT_RESOLVE_BUFFER_MS,
  TIMEOUT_RESOLVE_GRACE_MS,
  toMatchStatePayload,
  type Seat,
} from './possession-state.js';
import {
  computeResumedPossessionTiming,
  getNextQuestionDelayMs,
  shouldResolveExpiredQuestionOnResume,
  shouldResolveQuestionTimeoutNow,
} from './possession-timing.js';
import { getMultipleChoiceCorrectIndexFromPayload, normalizeMatchQuestionPayload } from './question-compat.js';
import { createReadyGateRegistry } from './ready-gate.js';
import { checkDevPauseAndDefer } from './services/dev-realtime.service.js';
import {
  markMatchEnteredForRoom,
  markMatchEnteredForSocket,
} from './services/match-entry.service.js';
import { getRedisClient } from './redis.js';
import type { QuizballServer, QuizballSocket } from './socket-server.js';
import type { MatchQuestionKind } from './socket.types.js';

const SPECIAL_QUESTION_CANDIDATE_LIMIT = 50;

// The 0-based slot within a half whose question is forced to be an image MCQ
// (the 4th question → slot index 3). See questionTypeForState / NORMAL_HALF_SEQUENCE.
const IMAGE_MCQ_SLOT_INDEX = 3;
// TEST ONLY (remove/replace tomorrow): the Q4 image-MCQ is pinned to the
// "Maradona's World Cup Legacy" category. The real flow will instead pull from
// whichever categories actually contain image questions.
const IMAGE_MCQ_TEST_CATEGORY_IDS = ['a7e48fee-b708-4272-acdc-854588179393'];
const GOAL_ROUND_READY_ACK_CEILING_MS =
  FRONTEND_RESULT_HOLD_MS + FRONTEND_TRANSITION_DELAY_MS + FRONTEND_GOAL_CELEBRATION_MS + 2000;

const pendingReadyGates = createReadyGateRegistry<number>();

async function getPauseStartedAt(matchId: string): Promise<string | null> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return null;
  return redis.get(matchPauseKey(matchId));
}

export function handlePossessionReadyForNextQuestion(
  userId: string,
  matchId: string,
  qIndex: number
): void {
  pendingReadyGates.acknowledge(userId, matchId, qIndex);
}

export function clearQuestionTimer(matchId: string, qIndex: number): void {
  const key = questionTimerKey(matchId, qIndex);
  void cancelRealtimeTimer('possession_question', key).catch((error) => {
    logger.warn({ error, matchId, qIndex }, 'Failed to cancel possession question timer');
  });
}

function scheduleQuestionTimeout(
  _io: QuizballServer,
  matchId: string,
  qIndex: number,
  deadlineAt: Date
): void {
  const key = questionTimerKey(matchId, qIndex);
  const dueAt = new Date(deadlineAt.getTime() + TIMEOUT_RESOLVE_GRACE_MS + TIMEOUT_RESOLVE_BUFFER_MS);
  void scheduleRealtimeTimer('possession_question', key, dueAt, {
    kind: 'possession_question',
    matchId,
    qIndex,
  }).catch((error) => {
    logger.error({ error, matchId, qIndex }, 'Failed to schedule possession question timer');
  });
}

export async function emitMatchState(io: QuizballServer, matchId: string, state: PossessionStatePayload): Promise<void> {
  io.to(`match:${matchId}`).emit('match:state', toMatchStatePayload(matchId, state));
  logger.info(
    {
      eventName: 'match:state',
      matchId,
      statePhase: state.phase,
      half: state.half,
      possessionDiff: state.possessionDiff,
      currentQuestionQIndex: state.currentQuestion?.qIndex ?? null,
      speedStreakHolderSeat: state.speedStreakHolderSeat,
    },
    'Possession match state emitted'
  );
}

async function emitPossessionAnswerSnapshotToSocket(
  socket: QuizballSocket,
  cache: MatchCache
): Promise<void> {
  const userId = socket.data.user.id;
  const answerAck = buildCachedAnswerAckPayload(cache, userId);
  if (answerAck) {
    socket.emit('match:answer_ack', answerAck);
    logger.info(
      {
        eventName: 'match:answer_ack',
        matchId: cache.matchId,
        qIndex: cache.currentQuestion?.qIndex ?? null,
        userId,
        socketId: socket.id,
        ...questionLogFields(cache.currentQuestion),
        ...answerLogFields(cache.answers[userId]),
      },
      'Possession cached answer snapshot emitted to socket'
    );
    return;
  }

  const question = cache.currentQuestion;
  if (!question) return;

  if (question.kind !== 'countdown' || question.evaluation.kind !== 'countdown') return;

  const foundIds = await countdownGetFound(cache.matchId, userId);
  if (foundIds.length === 0) return;

  const foundIdSet = new Set(foundIds);
  const acceptedDisplays = question.evaluation.answerGroups
    .filter((group) => foundIdSet.has(group.id))
    .map((group) => group.display);
  const latestDisplay = acceptedDisplays[acceptedDisplays.length - 1];

  socket.emit('match:countdown_guess_ack', {
    matchId: cache.matchId,
    qIndex: question.qIndex,
    accepted: true,
    duplicate: false,
    foundCount: foundIds.length,
    acceptedDisplay: latestDisplay,
    acceptedDisplays,
  });
  logger.info(
    {
      eventName: 'match:countdown_guess_ack',
      matchId: cache.matchId,
      qIndex: question.qIndex,
      userId,
      socketId: socket.id,
      foundCount: foundIds.length,
      ...questionLogFields(question),
    },
    'Possession countdown snapshot emitted to socket'
  );
}

export async function emitPossessionStateToSocket(socket: QuizballSocket, matchId: string): Promise<void> {
  const cache = await getMatchCacheOrRebuild(matchId);
  if (cache) {
    socket.emit('match:state', toMatchStatePayload(matchId, cache.statePayload));
    logger.info(
      {
        eventName: 'match:state',
        matchId,
        userId: socket.data.user.id,
        socketId: socket.id,
        ...cacheLogFields(cache),
      },
      'Possession cached state emitted to socket'
    );
    if (cache.currentQuestion) {
      socket.emit('match:question', {
        matchId,
        qIndex: cache.currentQuestion.qIndex,
        total: cache.totalQuestions,
        question: cache.currentQuestion.questionDTO,
        playableAt: cache.currentQuestion.shownAt ?? undefined,
        deadlineAt: cache.currentQuestion.deadlineAt ?? new Date().toISOString(),
        serverNow: new Date().toISOString(),
        // MCQ correctIndex is shipped so the client can show instant tap
        // feedback (matches Trivia Crack / QuizUp pattern). Server still
        // validates the selectedIndex independently when scoring.
        correctIndex: cache.currentQuestion.kind === 'multipleChoice'
          ? cache.currentQuestion.correctIndex
          : undefined,
        phaseKind: cache.currentQuestion.phaseKind,
        phaseRound: cache.currentQuestion.phaseRound,
        shooterSeat: cache.currentQuestion.shooterSeat,
        attackerSeat: cache.currentQuestion.attackerSeat,
      });
      await markMatchEnteredForSocket(socket, matchId, 'possession_cached_question');
      logger.info(
        {
          eventName: 'match:question',
          matchId,
          qIndex: cache.currentQuestion.qIndex,
          userId: socket.data.user.id,
          socketId: socket.id,
          totalQuestions: cache.totalQuestions,
          ...questionLogFields(cache.currentQuestion),
        },
        'Possession cached question emitted to socket'
      );
    }
    await emitPossessionAnswerSnapshotToSocket(socket, cache);
    return;
  }

  const match = await matchesRepo.getMatch(matchId);
  if (!match) return;
  const state = parsePossessionState(match.state_payload);
  socket.emit('match:state', toMatchStatePayload(matchId, state));
  logger.info(
    {
      eventName: 'match:state',
      matchId,
      userId: socket.data.user.id,
      socketId: socket.id,
      statePhase: state.phase,
      half: state.half,
      currentQuestionQIndex: state.currentQuestion?.qIndex ?? null,
    },
    'Possession DB state emitted to socket'
  );
}

interface PickedQuestion {
  questionId: string;
  categoryId: string;
  correctIndex: number;
  questionKind: MatchQuestionKind;
}

/**
 * Scan a candidate batch and return the first row whose payload is a valid
 * question of `questionType` (well-formed MCQ with a correct option, or a valid
 * special question). The single authority for "valid candidate" — both the
 * normal and image-MCQ selection paths use it so they can't drift.
 */
function pickFirstValidCandidate(
  rows: Array<{ id: string; category_id: string; payload: unknown }>,
  questionType: QuestionType,
  logContext: Record<string, unknown>
): PickedQuestion | null {
  let invalidCandidateCount = 0;
  for (const row of rows) {
    const parsed = questionPayloadSchema.safeParse(row.payload);
    if (!parsed.success || parsed.data.type !== questionType) {
      invalidCandidateCount += 1;
      continue;
    }

    const correctIndex = parsed.data.type === 'mcq_single'
      ? parsed.data.options.findIndex((option) => option.is_correct)
      : 0;
    if (parsed.data.type === 'mcq_single' && correctIndex < 0) {
      invalidCandidateCount += 1;
      continue;
    }

    logger.info(
      {
        ...logContext,
        questionType,
        candidateCount: rows.length,
        invalidCandidateCount,
        questionId: row.id,
        categoryId: row.category_id,
        questionKind: questionKindForType(questionType),
      },
      'Possession question candidate picked'
    );
    return {
      questionId: row.id,
      categoryId: row.category_id,
      correctIndex,
      questionKind: questionKindForType(questionType),
    };
  }

  logger.warn(
    {
      ...logContext,
      questionType,
      candidateCount: rows.length,
      invalidCandidateCount,
    },
    'Possession question candidate search returned no valid question'
  );
  return null;
}

function isImageMcqSlot(state: PossessionStatePayload): boolean {
  return (
    state.phase === 'NORMAL_PLAY' &&
    state.normalQuestionsAnsweredInHalf % POSSESSION_QUESTIONS_PER_HALF === IMAGE_MCQ_SLOT_INDEX
  );
}

/**
 * For the image-MCQ slot, pick a random published image MCQ from the pinned
 * category. Returns null (→ caller falls back to a normal MCQ) when the pool is
 * empty/exhausted, so the match never stalls.
 */
async function pickImageMcqForState(matchId: string): Promise<PickedQuestion | null> {
  const rows = await matchQuestionsRepo.getRandomImageMcqCandidatesForMatch({
    matchId,
    categoryIds: IMAGE_MCQ_TEST_CATEGORY_IDS,
    limit: SPECIAL_QUESTION_CANDIDATE_LIMIT,
  });
  return pickFirstValidCandidate(rows, 'mcq_single', {
    matchId,
    imageMcqSlot: true,
    categoryIds: IMAGE_MCQ_TEST_CATEGORY_IDS,
  });
}

async function maybePickQuestionForState(
  matchId: string,
  state: PossessionStatePayload,
  categoryIds: string[]
): Promise<PickedQuestion | null> {
  if (isImageMcqSlot(state)) {
    const imagePicked = await pickImageMcqForState(matchId);
    if (imagePicked) return imagePicked;
    logger.warn(
      { matchId, imageMcqSlot: true, categoryIds: IMAGE_MCQ_TEST_CATEGORY_IDS },
      'No image MCQ available for Q4 slot; falling back to a normal MCQ'
    );
    // fall through to the normal mcq_single path below
  }

  const questionType = questionTypeForState(state);
  const useDifficulty = questionType === 'mcq_single';
  const preferredDifficulties = useDifficulty ? getDifficultyForState(state) : undefined;
  const pickValidCandidate = async (
    difficulties?: Array<'easy' | 'medium' | 'hard'>
  ): Promise<PickedQuestion | null> => {
    const rows = await matchQuestionsRepo.getRandomQuestionCandidatesForMatch({
      matchId,
      categoryIds,
      difficulties,
      questionTypes: [questionType],
      limit: questionType === 'mcq_single' ? 1 : SPECIAL_QUESTION_CANDIDATE_LIMIT,
    });
    return pickFirstValidCandidate(rows, questionType, { matchId, categoryIds, difficulties });
  };

  let picked = await pickValidCandidate(preferredDifficulties);
  if (!picked && useDifficulty) {
    picked = await pickValidCandidate(['easy', 'medium', 'hard']);
  }

  return picked;
}

export async function scheduleNextPossessionQuestion(
  io: QuizballServer,
  matchId: string,
  cache: MatchCache | null,
  params: {
    phase: PossessionStatePayload['phase'];
    phaseKind: 'normal' | 'last_attack' | 'penalty' | 'shot';
    resolvedQIndex: number;
    nextIndex: number;
    goalScoredBySeat: Seat | null;
  }
): Promise<void> {
  const { phase, phaseKind, resolvedQIndex, nextIndex, goalScoredBySeat } = params;
  logger.info(
    { matchId, phase, phaseKind, resolvedQIndex, nextIndex, goalScoredBySeat },
    'Possession next question scheduling requested'
  );
  const dispatch = (opts?: { postReadyAck?: boolean }) => {
    const fire = () => {
      logger.info(
        { matchId, nextIndex, postReadyAck: opts?.postReadyAck ?? false },
        'Possession next question dispatch firing'
      );
      void sendPossessionMatchQuestion(io, matchId, nextIndex, opts).catch((error) => {
        logger.error({ error, matchId, nextIndex }, 'Failed to send next possession question');
      });
    };
    void checkDevPauseAndDefer(matchId, fire).then((deferred) => {
      if (!deferred) fire();
    });
  };

  if (goalScoredBySeat && phaseKind !== 'penalty') {
    const humanUserIds: string[] = [];
    if (cache) {
      const aiUserId = await resolveAiUserIdForMatch(matchId);
      for (const player of cache.players) {
        if (player.userId !== aiUserId) humanUserIds.push(player.userId);
      }
    }
    if (humanUserIds.length === 0) {
      logger.info(
        { matchId, resolvedQIndex, nextIndex, goalScoredBySeat },
        'Possession goal transition has no human ready gate waiters'
      );
      setTimeout(() => dispatch({ postReadyAck: true }), 0);
      return;
    }

    logger.info(
      { matchId, resolvedQIndex, nextIndex, goalScoredBySeat, waitingUserIds: humanUserIds },
      'Possession goal transition waiting for ready acks'
    );
    pendingReadyGates.open({
      scopeId: matchId,
      token: resolvedQIndex,
      waitingUserIds: humanUserIds,
      // Harness has no real client to send the post-goal ready ack, so it would
      // sit the full ~9s ceiling on EVERY goal. Collapse the ceiling under
      // fast-timers (prod untouched) so goals don't dominate match time.
      ceilingMs: harnessDelayMs(GOAL_ROUND_READY_ACK_CEILING_MS),
      dispatch: () => dispatch({ postReadyAck: true }),
      onTimeout: (missing) => {
        logger.info({ matchId, resolvedQIndex, missing }, 'Ready-ack ceiling reached — sending next question anyway');
      },
    });
    return;
  }

  // The inter-question delay mirrors the FRONTEND result-hold + transition + reveal
  // (~6s/round). In the regression harness this is the dominant per-match cost
  // (~13 rounds => ~80s), so collapse it to a few ms when fast-timers are on.
  // Production is untouched (harnessDelayMs returns prodMs unless REGRESSION_FAST_TIMERS).
  const delay = harnessDelayMs(getNextQuestionDelayMs({ phase }));
  logger.info({ matchId, nextIndex, phase, delayMs: delay }, 'Possession next question scheduled after delay');
  setTimeout(() => dispatch(), delay);
}

export async function sendPossessionMatchQuestion(
  io: QuizballServer,
  matchId: string,
  qIndex: number,
  preloaded?: { cache?: MatchCache; postReadyAck?: boolean }
): Promise<{ correctIndex: number } | null> {
  return withSpan('match.possession.send_question', {
    'quizball.match_id': matchId,
    'quizball.q_index': qIndex,
  }, async (span) => {
    const startedAt = Date.now();
    const cache = preloaded?.cache ?? await getMatchCacheOrRebuild(matchId);
    if (!cache || cache.status !== 'active') {
      logger.warn(
        { matchId, qIndex, postReadyAck: preloaded?.postReadyAck ?? false, ...cacheLogFields(cache) },
        'Possession question dispatch skipped: inactive or missing cache'
      );
      return null;
    }

    const pauseStartedAt = await getPauseStartedAt(matchId);
    if (pauseStartedAt) {
      logger.info(
        {
          eventName: 'match:question',
          matchId,
          qIndex,
          pauseStartedAt,
          postReadyAck: preloaded?.postReadyAck ?? false,
          ...cacheLogFields(cache),
        },
        'Possession question dispatch skipped: match paused'
      );
      return null;
    }

    const totalQuestions = cache.totalQuestions;
    const state = cache.statePayload;

    span.setAttributes({
      'quizball.match_phase': state.phase,
      'quizball.match_half': state.half,
    });

    if (state.phase === 'HALFTIME') {
      logger.info({ matchId, qIndex, half: state.half }, 'Possession question dispatch entered halftime state handling');
      await ensureHalftimeCategories(state, cache.categoryAId, matchId, cache.categoryBId);
      if (!state.halftime.deadlineAt) {
        state.halftime.deadlineAt = new Date(Date.now() + HALFTIME_DURATION_MS).toISOString();
      }
      scheduleHalftimeTimeout(io, matchId);
      schedulePossessionAiHalftimeBan(io, matchId);
      bumpStateVersion(state);
      await setMatchCache(cache);
      fireAndForget('setMatchStatePayload(sendQuestion:halftime)', async () => {
        await matchesRepo.setMatchStatePayload(matchId, state, cache.currentQIndex);
      });
      await emitMatchState(io, matchId, state);
      return null;
    }
    if (state.phase === 'COMPLETED') {
      logger.info({ matchId, qIndex }, 'Possession question dispatch skipped: match already completed');
      return null;
    }

    const phaseKind = phaseKindFromState(state);
    const runtimePhaseKind: 'normal' | 'last_attack' | 'penalty' = phaseKind === 'shot' ? 'normal' : phaseKind;
    const attackerSeat = runtimePhaseKind === 'last_attack'
      ? (state.lastAttack.attackerSeat ?? (state.possessionDiff >= 0 ? 1 : 2))
      : null;
    const shooterSeat = runtimePhaseKind === 'penalty' ? state.penalty.shooterSeat : null;
    const phaseRound = runtimePhaseKind === 'normal'
      ? state.normalQuestionsAnsweredTotal + 1
      : runtimePhaseKind === 'last_attack'
        ? state.half
        : Math.ceil(state.penalty.round / 2);

    span.setAttributes({
      'quizball.phase_kind': runtimePhaseKind,
      'quizball.phase_round': phaseRound,
    });

    const categoryIds = categoryIdsForCurrentHalf(state, cache);
    const picked = await maybePickQuestionForState(matchId, state, categoryIds);
    if (!picked) {
      logger.error(
        { matchId, qIndex, phaseKind, categoryIds, statePhase: state.phase, half: state.half },
        'Failed to pick a valid question for possession state'
      );
      return null;
    }

    span.setAttributes({
      'quizball.question_id': picked.questionId,
      'quizball.category_id': picked.categoryId,
    });

    const inserted = await matchQuestionsRepo.insertMatchQuestionIfMissing({
      matchId,
      qIndex,
      questionId: picked.questionId,
      categoryId: picked.categoryId,
      correctIndex: picked.correctIndex,
      phaseKind: runtimePhaseKind,
      phaseRound,
      shooterSeat,
      attackerSeat,
    });

    if (!inserted) {
      logger.warn({ matchId, qIndex, phaseKind: runtimePhaseKind }, 'Question row already exists for possession qIndex');
      span.setAttribute('quizball.question_row_preexisting', true);
    }

    const payload = normalizeMatchQuestionPayload(await matchesService.buildMatchQuestionPayload(matchId, qIndex));
    if (!payload) {
      logger.error({ matchId, qIndex }, 'Unable to build possession match question payload');
      return null;
    }
    const correctIndex = getMultipleChoiceCorrectIndexFromPayload(payload) ?? 0;

    const previousQuestionKind = cache.currentQuestion?.kind;
    const clueCount = payload.question.kind === 'clues' ? payload.question.clues.length : undefined;
    const { playableAt, deadlineAt } = buildPlayableQuestionTiming({
      qIndex,
      state,
      questionKind: payload.question.kind,
      previousQuestionKind,
      clueCount,
      postReadyAck: preloaded?.postReadyAck,
    });

    state.currentQuestion = {
      qIndex,
      phaseKind: runtimePhaseKind,
      phaseRound,
      shooterSeat,
      attackerSeat,
    };
    cache.currentQIndex = qIndex;
    cache.currentQuestion = {
      qIndex,
      kind: payload.question.kind,
      questionId: payload.question.id,
      correctIndex,
      phaseKind: runtimePhaseKind,
      phaseRound,
      shooterSeat,
      attackerSeat,
      shownAt: playableAt.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
      questionDTO: payload.question,
      evaluation: payload.evaluation,
      reveal: payload.reveal,
    };
    cache.answers = {};
    bumpStateVersion(state);

    await setMatchCache(cache);
    // Routine question dispatch only advances the q-index heartbeat; the full
    // state_payload checkpoint happens at recovery-relevant boundaries (see
    // the resolver's checkpoint policy + rebuildCacheFromDB taking the max of
    // the column and the embedded state qIndex). db-optimize.md #7.
    fireAndForget('touchMatchRound(sendQuestion)', async () => {
      await matchesRepo.touchMatchRound(matchId, qIndex);
    });
    try {
      await matchQuestionsRepo.setQuestionTiming(matchId, qIndex, playableAt, deadlineAt);
    } catch (error) {
      logger.error({ error, matchId, qIndex }, 'setQuestionTiming failed before emitting match:question');
    }

    await emitMatchState(io, matchId, state);

    logger.info(
      {
        eventName: 'match:question',
        matchId,
        qIndex,
        totalQuestions,
        pickedQuestionId: picked.questionId,
        pickedCategoryId: picked.categoryId,
        previousQuestionKind,
        playableAt: playableAt.toISOString(),
        deadlineAt: deadlineAt.toISOString(),
        postReadyAck: preloaded?.postReadyAck ?? false,
        ...questionLogFields(cache.currentQuestion),
      },
      'Possession question dispatch emitting match:question'
    );
    io.to(`match:${matchId}`).emit('match:question', {
      matchId,
      qIndex,
      total: totalQuestions,
      question: cache.currentQuestion.questionDTO,
      playableAt: playableAt.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
      serverNow: new Date().toISOString(),
      correctIndex: cache.currentQuestion.kind === 'multipleChoice'
        ? cache.currentQuestion.correctIndex
        : undefined,
      phaseKind: runtimePhaseKind,
      phaseRound,
      shooterSeat,
      attackerSeat,
    });
    await markMatchEnteredForRoom(io, matchId, 'possession_question');

    appMetrics.questionGenerationDuration.record(Date.now() - startedAt, {
      mode: cache.mode,
      variant: cache.statePayload.variant,
      phase_kind: runtimePhaseKind,
    });

    scheduleQuestionTimeout(io, matchId, qIndex, deadlineAt);
    logger.info(
      {
        eventName: 'match:question_timer',
        matchId,
        qIndex,
        deadlineAt: deadlineAt.toISOString(),
        questionKind: payload.question.kind,
        phaseKind: runtimePhaseKind,
        phaseRound,
      },
      'Possession question timers scheduled'
    );
    void schedulePossessionAiAnswer(io, matchId, qIndex, {
      questionKind: payload.question.kind,
      evaluation: payload.evaluation,
      phaseKind: runtimePhaseKind,
      phaseRound,
      shooterSeat,
      playableAt,
      deadlineAt,
    }).catch((error) => {
      logger.warn({ error, matchId, qIndex }, 'Failed to schedule possession AI answer');
    });

    return { correctIndex: cache.currentQuestion.correctIndex };
  });
}

export async function resumePossessionMatchQuestion(
  io: QuizballServer,
  matchId: string,
  qIndex: number,
  pauseStartedAtMs: number
): Promise<boolean> {
  const cache = await getMatchCacheOrRebuild(matchId);
  if (!cache || cache.status !== 'active') {
    logger.warn(
      { matchId, qIndex, pauseStartedAtMs, ...cacheLogFields(cache) },
      'Possession question resume skipped: inactive or missing cache'
    );
    return false;
  }

  const currentQuestion = cache.currentQuestion;
  if (!currentQuestion || currentQuestion.qIndex !== qIndex) {
    logger.warn(
      { matchId, qIndex, pauseStartedAtMs, ...cacheLogFields(cache), ...questionLogFields(currentQuestion) },
      'Possession question resume skipped: stale or missing current question'
    );
    return false;
  }

  if (shouldResolveExpiredQuestionOnResume(currentQuestion.deadlineAt, pauseStartedAtMs)) {
    logger.info(
      {
        eventName: 'match:question_timer',
        matchId,
        qIndex,
        pauseStartedAtMs,
        existingDeadlineAt: currentQuestion.deadlineAt,
        ...questionLogFields(currentQuestion),
      },
      'Possession question resume resolving expired question instead of replaying'
    );
    await resolvePossessionRound(io, matchId, qIndex, true);
    return true;
  }

  const resumedAtMs = Date.now();
  const { playableAt, deadlineAt } = computeResumedPossessionTiming({
    shownAtRaw: currentQuestion.shownAt,
    deadlineAtRaw: currentQuestion.deadlineAt,
    pauseStartedAtMs,
    resumedAtMs,
    qIndex,
    state: cache.statePayload,
    questionKind: currentQuestion.kind,
  });

  currentQuestion.shownAt = playableAt.toISOString();
  currentQuestion.deadlineAt = deadlineAt.toISOString();
  cache.currentQIndex = qIndex;

  await setMatchCache(cache);
  fireAndForget('setQuestionTiming(resumeQuestion)', async () => {
    await matchQuestionsRepo.setQuestionTiming(matchId, qIndex, playableAt, deadlineAt);
  });

  await emitMatchState(io, matchId, cache.statePayload);
  logger.info(
    {
      eventName: 'match:question',
      matchId,
      qIndex,
      pauseStartedAtMs,
      playableAt: playableAt.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
      ...questionLogFields(currentQuestion),
    },
    'Possession resumed question emitting match:question'
  );
  io.to(`match:${matchId}`).emit('match:question', {
    matchId,
    qIndex,
    total: cache.totalQuestions,
    question: currentQuestion.questionDTO,
    playableAt: playableAt.toISOString(),
    deadlineAt: deadlineAt.toISOString(),
    serverNow: new Date().toISOString(),
    correctIndex: currentQuestion.kind === 'multipleChoice'
      ? currentQuestion.correctIndex
      : undefined,
    phaseKind: currentQuestion.phaseKind,
    phaseRound: currentQuestion.phaseRound,
    shooterSeat: currentQuestion.shooterSeat,
    attackerSeat: currentQuestion.attackerSeat,
  });
  await markMatchEnteredForRoom(io, matchId, 'possession_resumed_question');

  scheduleQuestionTimeout(io, matchId, qIndex, deadlineAt);
  logger.info(
    { eventName: 'match:question_timer', matchId, qIndex, deadlineAt: deadlineAt.toISOString(), ...questionLogFields(currentQuestion) },
    'Possession resumed question timers scheduled'
  );
  void schedulePossessionAiAnswer(io, matchId, qIndex, {
    questionKind: currentQuestion.kind,
    evaluation: currentQuestion.evaluation,
    phaseKind: currentQuestion.phaseKind,
    phaseRound: currentQuestion.phaseRound ?? 0,
    shooterSeat: currentQuestion.shooterSeat,
    playableAt,
    deadlineAt,
  }).catch((error) => {
    logger.warn({ error, matchId, qIndex }, 'Failed to reschedule possession AI answer after resume');
  });

  return true;
}

export async function ensurePossessionActiveTimers(
  io: QuizballServer,
  matchId: string
): Promise<boolean> {
  const cache = await getMatchCacheOrRebuild(matchId);
  if (!cache || cache.status !== 'active') {
    logger.warn({ eventName: 'match:question_timer', matchId, ...cacheLogFields(cache) }, 'Possession timer ensure skipped: inactive or missing cache');
    return false;
  }

  const state = cache.statePayload;
  if (state.phase === 'HALFTIME') {
    logger.info({ eventName: 'match:halftime_timer', matchId, half: state.half }, 'Possession timer ensure scheduling halftime timers');
    scheduleHalftimeTimeout(io, matchId);
    schedulePossessionAiHalftimeBan(io, matchId);
    return true;
  }

  const currentQuestion = cache.currentQuestion;
  if (!currentQuestion) {
    logger.warn({ eventName: 'match:question_timer', matchId, ...cacheLogFields(cache) }, 'Possession timer ensure skipped: missing current question');
    return false;
  }

  const deadlineAt = currentQuestion.deadlineAt ? new Date(currentQuestion.deadlineAt) : null;
  if (!deadlineAt || Number.isNaN(deadlineAt.getTime())) {
    logger.warn(
      { eventName: 'match:question_timer', matchId, qIndex: currentQuestion.qIndex, deadlineAtRaw: currentQuestion.deadlineAt, ...questionLogFields(currentQuestion) },
      'Possession timer ensure resolving question with invalid deadline'
    );
    await resolvePossessionRound(io, matchId, currentQuestion.qIndex, true);
    return true;
  }

  const nowMs = Date.now();
  if (shouldResolveQuestionTimeoutNow(currentQuestion.deadlineAt, nowMs)) {
    logger.info(
      {
        eventName: 'match:question_timer',
        matchId,
        qIndex: currentQuestion.qIndex,
        deadlineAt: deadlineAt.toISOString(),
        checkedAt: new Date(nowMs).toISOString(),
        ...questionLogFields(currentQuestion),
      },
      'Possession timer ensure resolving expired question immediately'
    );
    await resolvePossessionRound(io, matchId, currentQuestion.qIndex, true);
    return true;
  }

  scheduleQuestionTimeout(io, matchId, currentQuestion.qIndex, deadlineAt);
  // Reconnect/resume path: only schedule AI answer if no plan exists yet.
  // Rescheduling here would re-randomize the AI's plan and shift the
  // deadline forward, breaking live timing for ongoing rounds.
  const aiAnswerKey = questionTimerKey(matchId, currentQuestion.qIndex);
  const aiAlreadyScheduled = await hasPendingRealtimeTimer('possession_ai_answer', aiAnswerKey);
  if (aiAlreadyScheduled) {
    logger.info(
      { eventName: 'match:question_timer', matchId, qIndex: currentQuestion.qIndex, deadlineAt: deadlineAt.toISOString(), ...questionLogFields(currentQuestion) },
      'Possession timer ensure kept existing AI answer timer'
    );
    return true;
  }
  logger.info(
    { eventName: 'match:question_timer', matchId, qIndex: currentQuestion.qIndex, deadlineAt: deadlineAt.toISOString(), ...questionLogFields(currentQuestion) },
    'Possession timer ensure scheduling question and AI timers'
  );
  void schedulePossessionAiAnswer(io, matchId, currentQuestion.qIndex, {
    questionKind: currentQuestion.kind,
    evaluation: currentQuestion.evaluation,
    phaseKind: currentQuestion.phaseKind,
    phaseRound: currentQuestion.phaseRound ?? 0,
    shooterSeat: currentQuestion.shooterSeat,
    playableAt: currentQuestion.shownAt ? new Date(currentQuestion.shownAt) : undefined,
    deadlineAt,
  }).catch((error) => {
    logger.warn({ error, matchId, qIndex: currentQuestion.qIndex }, 'Failed to ensure possession AI answer timer');
  });
  return true;
}
