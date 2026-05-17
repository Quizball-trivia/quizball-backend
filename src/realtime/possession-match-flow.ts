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
import { appMetrics } from '../core/metrics.js';
import { withSpan } from '../core/tracing.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import {
  matchesService,
  POSSESSION_QUESTIONS_PER_HALF,
  type PossessionStatePayload,
} from '../modules/matches/matches.service.js';
import { questionPayloadSchema } from '../modules/questions/questions.schemas.js';
import { acquireLock, releaseLock } from './locks.js';
import {
  answerCount,
  countdownGetFound,
  deleteCountdownPlayerKeys,
  getCachedPlayer,
  getExpectedUserIds,
  getMatchCacheOrRebuild,
  setMatchCache,
  type CachedAnswer,
  type MatchCache,
} from './match-cache.js';
import { getMultipleChoiceCorrectIndexFromPayload, normalizeMatchQuestionPayload } from './question-compat.js';
import { getRedisClient } from './redis.js';
import { checkDevPauseAndDefer } from './services/dev-realtime.service.js';
import { createReadyGateRegistry } from './ready-gate.js';
import { questionTimerKey } from './match-keys.js';
import type { QuizballServer, QuizballSocket } from './socket-server.js';
import type {
  MatchQuestionKind,
  MatchRoundResultDeltas,
} from './socket.types.js';
import { calculateCountdownScore } from './scoring.js';

// ── Re-exports from extracted sub-modules ──
import {
  getQuestionDurationMs,
  FRONTEND_RESULT_HOLD_MS,
  FRONTEND_TRANSITION_DELAY_MS,
  FRONTEND_GOAL_CELEBRATION_MS,
  TIMEOUT_RESOLVE_GRACE_MS,
  TIMEOUT_RESOLVE_BUFFER_MS,
  type Seat,
  asSeat,
  nextSeat,
  seatToBanKey,
  buildPlayableQuestionTiming,
  parsePossessionState,
  phaseKindFromState,
  getDifficultyForState,
  toMatchStatePayload,
  bumpStateVersion,
} from './possession-state.js';

import { createPossessionAi } from './possession-ai.js';
import { createPossessionHalftime, HALFTIME_DURATION_MS, HALFTIME_POST_BAN_REVEAL_MS } from './possession-halftime.js';
import {
  clueIndexForTimeMs,
  countdownMatch,
  normalizeAnswer,
} from './possession-answer-matching.js';
import {
  computeAuthoritativeTimeMs,
  computeResumedPossessionTiming,
  getNextQuestionDelayMs,
} from './possession-timing.js';
import {
  buildCachedAnswerAckPayload,
  buildPlayersPayloadFromCache,
  getUserIdByCachedSeat,
  questionKindForType,
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

// ── Module-scoped Maps for timers ──

const questionTimers = new Map<string, NodeJS.Timeout>();

const SPECIAL_QUESTION_CANDIDATE_LIMIT = 50;
// Safety ceiling: if a client never acks ready (dropped, bug, slow device), send
// the next question anyway so the match doesn't stall.
const GOAL_ROUND_READY_ACK_CEILING_MS =
  FRONTEND_RESULT_HOLD_MS + FRONTEND_TRANSITION_DELAY_MS + FRONTEND_GOAL_CELEBRATION_MS + 2000;

// ── Ready-ack gate for goal rounds ───────────────────────────────────────────
// When a goal is scored, the client runs a celebration + transition sequence
// whose total length is animation-dependent. Instead of the server guessing
// that length with a fixed setTimeout (fragile), we wait for both players to
// emit 'match:ready_for_next_question' and then send the next question with
// playableAt = sendTime + REVEAL_MS only (no extra hold/transition buffer,
// since the client has already completed those). A ceiling timeout guards
// against a client never acking.
const pendingReadyGates = createReadyGateRegistry<number>();

export function handlePossessionReadyForNextQuestion(
  userId: string,
  matchId: string,
  qIndex: number
): void {
  pendingReadyGates.acknowledge(userId, matchId, qIndex);
}

export async function handlePossessionHalftimeUiReady(
  io: QuizballServer,
  userId: string,
  matchId: string
): Promise<void> {
  await handlePossessionHalftimeUiReadyInternal(io, userId, matchId);
}

async function scheduleNextPossessionQuestion(
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
  const dispatch = (opts?: { postReadyAck?: boolean }) => {
    const fire = () => {
      void sendPossessionMatchQuestion(io, matchId, nextIndex, opts).catch((error) => {
        logger.error({ error, matchId, nextIndex }, 'Failed to send next possession question');
      });
    };
    void checkDevPauseAndDefer(matchId, fire).then((deferred) => {
      if (!deferred) fire();
    });
  };

  if (goalScoredBySeat && phaseKind !== 'penalty') {
    // Wait for both human players to ack ready; ceiling timeout guards against
    // a client that never acks (drop, bug, slow device).
    const humanUserIds: string[] = [];
    if (cache) {
      const aiUserId = await resolveAiUserIdForMatch(matchId);
      for (const player of cache.players) {
        if (player.userId !== aiUserId) humanUserIds.push(player.userId);
      }
    }
    if (humanUserIds.length === 0) {
      // No humans to wait on (shouldn't happen, but be safe).
      setTimeout(() => dispatch({ postReadyAck: true }), 0);
      return;
    }

    pendingReadyGates.open({
      scopeId: matchId,
      token: resolvedQIndex,
      waitingUserIds: humanUserIds,
      ceilingMs: GOAL_ROUND_READY_ACK_CEILING_MS,
      dispatch: () => dispatch({ postReadyAck: true }),
      onTimeout: (missing) => {
        logger.info({ matchId, resolvedQIndex, missing }, 'Ready-ack ceiling reached — sending next question anyway');
      },
    });
    return;
  }

  const delay = getNextQuestionDelayMs({ phase });
  setTimeout(() => dispatch(), delay);
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

export { clearAiMaps, clearHalftimeTimer };

export async function emitMatchState(io: QuizballServer, matchId: string, state: PossessionStatePayload): Promise<void> {
  io.to(`match:${matchId}`).emit('match:state', toMatchStatePayload(matchId, state));
}

export async function emitPossessionStateToSocket(socket: QuizballSocket, matchId: string): Promise<void> {
  const cache = await getMatchCacheOrRebuild(matchId);
  if (cache) {
    socket.emit('match:state', toMatchStatePayload(matchId, cache.statePayload));
    if (cache.currentQuestion) {
      socket.emit('match:question', {
        matchId,
        qIndex: cache.currentQuestion.qIndex,
        total: cache.totalQuestions,
        question: cache.currentQuestion.questionDTO,
        playableAt: cache.currentQuestion.shownAt ?? undefined,
        deadlineAt: cache.currentQuestion.deadlineAt ?? new Date().toISOString(),
        phaseKind: cache.currentQuestion.phaseKind,
        phaseRound: cache.currentQuestion.phaseRound,
        shooterSeat: cache.currentQuestion.shooterSeat,
        attackerSeat: cache.currentQuestion.attackerSeat,
      });
    }
    await emitPossessionAnswerSnapshotToSocket(socket, cache);
    return;
  }

  const match = await matchesRepo.getMatch(matchId);
  if (!match) return;
  const state = parsePossessionState(match.state_payload);
  socket.emit('match:state', toMatchStatePayload(matchId, state));
}

function clearQuestionTimer(matchId: string, qIndex: number): void {
  const key = questionTimerKey(matchId, qIndex);
  const timer = questionTimers.get(key);
  if (!timer) return;
  clearTimeout(timer);
  questionTimers.delete(key);
}

function scheduleQuestionTimeout(
  io: QuizballServer,
  matchId: string,
  qIndex: number,
  deadlineAt: Date
): void {
  const key = questionTimerKey(matchId, qIndex);
  const existing = questionTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  const delayMs = Math.max(0, deadlineAt.getTime() - Date.now()) + TIMEOUT_RESOLVE_GRACE_MS + TIMEOUT_RESOLVE_BUFFER_MS;
  const timeout = setTimeout(() => {
    void resolvePossessionRound(io, matchId, qIndex, true).catch((error) => {
      logger.error({ error, matchId, qIndex }, 'Failed to resolve possession round after timeout');
    });
  }, delayMs);

  questionTimers.set(key, timeout);
}

export function fireAndForget(label: string, fn: () => Promise<unknown>): void {
  fn().catch((error) => {
    logger.error({ error, label }, 'Fire-and-forget DB write failed');
  });
}

async function emitPossessionAnswerSnapshotToSocket(
  socket: QuizballSocket,
  cache: MatchCache
): Promise<void> {
  const userId = socket.data.user.id;
  const answerAck = buildCachedAnswerAckPayload(cache, userId);
  if (answerAck) {
    socket.emit('match:answer_ack', answerAck);
    return;
  }

  const question = cache.currentQuestion;
  if (!question || question.kind !== 'countdown' || question.evaluation.kind !== 'countdown') return;

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
}

async function maybePickQuestionForState(
  matchId: string,
  state: PossessionStatePayload,
  categoryIds: string[]
): Promise<{
  questionId: string;
  categoryId: string;
  correctIndex: number;
  questionKind: MatchQuestionKind;
} | null> {
  const questionType = questionTypeForState(state);
  const useDifficulty = questionType === 'mcq_single';
  const preferredDifficulties = useDifficulty ? getDifficultyForState(state) : undefined;
  const pickValidCandidate = async (
    difficulties?: Array<'easy' | 'medium' | 'hard'>
  ): Promise<{
    questionId: string;
    categoryId: string;
    correctIndex: number;
    questionKind: MatchQuestionKind;
  } | null> => {
    const rows = await matchesRepo.getRandomQuestionCandidatesForMatch({
      matchId,
      categoryIds,
      difficulties,
      questionTypes: [questionType],
      limit: questionType === 'mcq_single' ? 1 : SPECIAL_QUESTION_CANDIDATE_LIMIT,
    });

    for (const row of rows) {
      const parsed = questionPayloadSchema.safeParse(row.payload);
      if (!parsed.success || parsed.data.type !== questionType) {
        continue;
      }

      const correctIndex = parsed.data.type === 'mcq_single'
        ? parsed.data.options.findIndex((option) => option.is_correct)
        : 0;
      if (parsed.data.type === 'mcq_single' && correctIndex < 0) {
        continue;
      }

      return {
        questionId: row.id,
        categoryId: row.category_id,
        correctIndex,
        questionKind: questionKindForType(questionType),
      };
    }

    return null;
  };

  let picked = await pickValidCandidate(preferredDifficulties);
  if (!picked && useDifficulty) {
    picked = await pickValidCandidate(['easy', 'medium', 'hard']);
  }

  return picked;
}

export async function handlePossessionHalftimeBan(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: { matchId: string; categoryId: string }
): Promise<void> {
  const lockKey = `lock:match:${payload.matchId}:halftime_ban`;
  const lock = await acquireLock(lockKey, 3000);
  if (!lock.acquired || !lock.token) {
    socket.emit('error', {
      code: 'MATCH_BUSY',
      message: 'Match is busy. Please retry halftime ban.',
    });
    return;
  }

  try {
    const cache = await getMatchCacheOrRebuild(payload.matchId);
    if (!cache || cache.status !== 'active') {
      socket.emit('error', {
        code: 'MATCH_NOT_ACTIVE',
        message: 'No active match found.',
      });
      return;
    }

    const state = cache.statePayload;
    if (state.phase !== 'HALFTIME') {
      socket.emit('error', {
        code: 'MATCH_INVALID_PHASE',
        message: 'Category bans are only allowed during halftime.',
      });
      return;
    }

    const player = getCachedPlayer(cache, socket.data.user.id);
    const seat = player?.seat ?? null;
    if (!seat) {
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'You are not a participant in this match.',
      });
      return;
    }

    const seatKey = seatToBanKey(seat);
    const otherSeatKey = seatKey === 'seat1' ? 'seat2' : 'seat1';
    const turnSeat = getHalftimeTurnSeat(state);
    if (!turnSeat || seat !== turnSeat) {
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'It is not your turn to ban yet.',
      });
      return;
    }
    const validOptionIds = new Set(state.halftime.categoryOptions.map((category) => category.id));
    if (!validOptionIds.has(payload.categoryId)) {
      socket.emit('error', {
        code: 'INVALID_CATEGORY',
        message: 'Selected category is not available for halftime banning.',
      });
      return;
    }

    if (state.halftime.bans[seatKey]) {
      socket.emit('error', {
        code: 'MATCH_ALREADY_BANNED',
        message: 'You already submitted your halftime ban.',
      });
      return;
    }

    if (state.halftime.bans[otherSeatKey] === payload.categoryId) {
      socket.emit('error', {
        code: 'MATCH_INVALID_BAN',
        message: 'That category is already banned by your opponent.',
      });
      return;
    }

    state.halftime.bans[seatKey] = payload.categoryId;
    bumpStateVersion(state);

    await setMatchCache(cache);
    fireAndForget('setMatchStatePayload(halftimeBan)', async () => {
      await matchesRepo.setMatchStatePayload(payload.matchId, state, cache.currentQIndex);
    });
    await emitMatchState(io, payload.matchId, state);

    if (state.halftime.bans.seat1 && state.halftime.bans.seat2) {
      scheduleFinalizeHalftime(io, payload.matchId, HALFTIME_POST_BAN_REVEAL_MS);
    } else {
      schedulePossessionAiHalftimeBan(io, payload.matchId);
    }
  } finally {
    await releaseLock(lockKey, lock.token);
  }
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
    if (!cache || cache.status !== 'active') return null;
    const totalQuestions = cache.totalQuestions;
    const state = cache.statePayload;

    span.setAttributes({
      'quizball.match_phase': state.phase,
      'quizball.match_half': state.half,
    });

    if (state.phase === 'HALFTIME') {
      await ensureHalftimeCategories(state, cache.categoryAId, matchId);
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
      logger.error({ matchId, phaseKind }, 'Failed to pick a valid question for possession state');
      return null;
    }

    span.setAttributes({
      'quizball.question_id': picked.questionId,
      'quizball.category_id': picked.categoryId,
    });

    const inserted = await matchesRepo.insertMatchQuestionIfMissing({
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
    fireAndForget('setMatchStatePayload(sendQuestion)', async () => {
      await matchesRepo.setMatchStatePayload(matchId, state, qIndex);
    });
    try {
      await matchesRepo.setQuestionTiming(matchId, qIndex, playableAt, deadlineAt);
    } catch (error) {
      logger.error({ error, matchId, qIndex }, 'setQuestionTiming failed before emitting match:question');
    }

    await emitMatchState(io, matchId, state);

    io.to(`match:${matchId}`).emit('match:question', {
      matchId,
      qIndex,
      total: totalQuestions,
      question: cache.currentQuestion.questionDTO,
      playableAt: playableAt.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
      phaseKind: runtimePhaseKind,
      phaseRound,
      shooterSeat,
      attackerSeat,
    });

    appMetrics.questionGenerationDuration.record(Date.now() - startedAt, {
      mode: cache.mode,
      variant: cache.statePayload.variant,
      phase_kind: runtimePhaseKind,
    });

    scheduleQuestionTimeout(io, matchId, qIndex, deadlineAt);
    void schedulePossessionAiAnswer(io, matchId, qIndex, {
      questionKind: payload.question.kind,
      evaluation: payload.evaluation,
      phaseKind: runtimePhaseKind,
      phaseRound,
      shooterSeat,
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
  if (!cache || cache.status !== 'active') return false;

  const currentQuestion = cache.currentQuestion;
  if (!currentQuestion || currentQuestion.qIndex !== qIndex) {
    return false;
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
    await matchesRepo.setQuestionTiming(matchId, qIndex, playableAt, deadlineAt);
  });

  await emitMatchState(io, matchId, cache.statePayload);
  io.to(`match:${matchId}`).emit('match:question', {
    matchId,
    qIndex,
    total: cache.totalQuestions,
    question: currentQuestion.questionDTO,
    playableAt: playableAt.toISOString(),
    deadlineAt: deadlineAt.toISOString(),
    phaseKind: currentQuestion.phaseKind,
    phaseRound: currentQuestion.phaseRound,
    shooterSeat: currentQuestion.shooterSeat,
    attackerSeat: currentQuestion.attackerSeat,
  });

  scheduleQuestionTimeout(io, matchId, qIndex, deadlineAt);
  void schedulePossessionAiAnswer(io, matchId, qIndex, {
    questionKind: currentQuestion.kind,
    evaluation: currentQuestion.evaluation,
    phaseKind: currentQuestion.phaseKind,
    phaseRound: currentQuestion.phaseRound ?? 0,
    shooterSeat: currentQuestion.shooterSeat,
  }).catch((error) => {
    logger.warn({ error, matchId, qIndex }, 'Failed to reschedule possession AI answer after resume');
  });

  return true;
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

export function cancelPossessionQuestionTimer(matchId: string, qIndex: number): void {
  clearQuestionTimer(matchId, qIndex);
  clearAiAnswerTimer(matchId, qIndex);
}

export function cancelPossessionHalftimeTimer(matchId: string): void {
  clearHalftimeTimer(matchId);
  clearAiMaps(matchId);
}

export async function devSkipToPossessionPhase(
  io: QuizballServer,
  matchId: string,
  target: 'halftime' | 'last_attack' | 'shot' | 'penalties' | 'second_half'
): Promise<void> {
  const cache = await getMatchCacheOrRebuild(matchId);
  if (!cache || cache.status !== 'active') return;

  // Cancel all active timers
  clearQuestionTimer(matchId, cache.currentQIndex);
  clearAiAnswerTimer(matchId, cache.currentQIndex);
  clearHalftimeTimer(matchId);

  const state = cache.statePayload;
  const nextQIndex = cache.currentQIndex + 1;

  switch (target) {
    case 'halftime':
      state.normalQuestionsAnsweredInHalf = POSSESSION_QUESTIONS_PER_HALF;
      state.phase = 'HALFTIME';
      state.halftime.deadlineAt = new Date(Date.now() + HALFTIME_DURATION_MS).toISOString();
      await ensureHalftimeCategories(state, cache.categoryAId, matchId);
      state.currentQuestion = null;
      break;

    case 'second_half':
      state.half = 2;
      state.phase = 'NORMAL_PLAY';
      state.possessionDiff = 0;
      state.kickOffSeat = nextSeat(state.kickOffSeat);
      state.lastAttack.attackerSeat = null;
      state.normalQuestionsAnsweredInHalf = 0;
      state.halftime.categoryOptions = [];
      state.halftime.firstBanSeat = null;
      state.halftime.bans.seat1 = null;
      state.halftime.bans.seat2 = null;
      state.halftime.deadlineAt = null;
      state.currentQuestion = null;
      break;

    case 'last_attack':
    case 'shot':
      state.phase = 'LAST_ATTACK';
      state.lastAttack.attackerSeat = 1;
      state.currentQuestion = null;
      break;

    case 'penalties':
      state.half = 2;
      state.normalQuestionsAnsweredInHalf = POSSESSION_QUESTIONS_PER_HALF;
      state.goals = { seat1: 1, seat2: 1 };
      state.phase = 'PENALTY_SHOOTOUT';
      state.penalty = {
        round: 1,
        shooterSeat: 1,
        suddenDeath: false,
        kicksTaken: { seat1: 0, seat2: 0 },
      };
      state.currentQuestion = null;
      break;
  }

  cache.currentQIndex = nextQIndex;
  cache.currentQuestion = null;
  cache.answers = {};
  bumpStateVersion(state);
  await setMatchCache(cache);
  fireAndForget('setMatchStatePayload(devSkip)', async () => {
    await matchesRepo.setMatchStatePayload(matchId, state, nextQIndex);
  });
  await emitMatchState(io, matchId, state);

  if (target === 'halftime') {
    scheduleHalftimeTimeout(io, matchId);
    schedulePossessionAiHalftimeBan(io, matchId);
  } else {
    await sendPossessionMatchQuestion(io, matchId, nextQIndex);
  }

  logger.info({ matchId, target, phase: state.phase }, 'Dev skip: state modified');
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
