import { trackEvent } from '../core/analytics.js';
import { trackMatchCompleted } from '../core/analytics/game-events.js';
import { BadRequestError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { appMetrics } from '../core/metrics.js';
import { withSpan } from '../core/tracing.js';
import { achievementsService } from '../modules/achievements/index.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import { progressionService } from '../modules/progression/progression.service.js';
import { rankedService } from '../modules/ranked/ranked.service.js';
import { storeService } from '../modules/store/store.service.js';
import {
  matchesService,
  POSSESSION_QUESTIONS_PER_HALF,
  type MatchQuestionEvaluation,
  type PossessionStatePayload,
} from '../modules/matches/matches.service.js';
import { questionPayloadSchema, type QuestionType } from '../modules/questions/questions.schemas.js';
import { acquireLock, releaseLock } from './locks.js';
import { rankedAiMatchKey } from './ai-ranked.constants.js';
import {
  answerCount,
  countdownAddFound,
  countdownGetFound,
  deleteCountdownPlayerKeys,
  deleteMatchCache,
  getCachedPlayer,
  getExpectedUserIds,
  getMatchCacheOrRebuild,
  hasUserAnswered,
  setMatchCache,
  type CachedAnswer,
  type CachedPlayer,
  type CachedSeat,
  type MatchCache,
} from './match-cache.js';
import { getCachedMultipleChoiceCorrectIndex, getMultipleChoiceCorrectIndexFromPayload, normalizeMatchQuestionPayload } from './question-compat.js';
import { getRedisClient } from './redis.js';
import { createReadyGateRegistry } from './ready-gate.js';
import { questionTimerKey, lastMatchKey } from './match-keys.js';
import type { QuizballServer, QuizballSocket } from './socket-server.js';
import type {
  MatchCluesGuessAckPayload,
  MatchQuestionKind,
  MatchRoundResultDeltas,
} from './socket.types.js';
import { clamp, calculatePoints, calculateCountdownScore } from './scoring.js';

// ── Re-exports from extracted sub-modules ──
import {
  QUESTION_TIME_MS,
  getQuestionDurationMs,
  ROUND_RESULT_DELAY_MS,
  PENALTY_INTRO_DELAY_MS,
  TIMEOUT_RESOLVE_GRACE_MS,
  TIMEOUT_RESOLVE_BUFFER_MS,
  LAST_MATCH_REPLAY_TTL_SEC,
  TIMING_DISCREPANCY_WARN_MS,
  type Seat,
  type ResolutionDecision,
  type ExpectedAnswerInfo,
  asSeat,
  nextSeat,
  getSeatFromUserId,
  getUserIdBySeat,
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

// ── Module-scoped Maps for timers ──

const questionTimers = new Map<string, NodeJS.Timeout>();

const NORMAL_HALF_SEQUENCE: QuestionType[] = [
  'mcq_single',
  'mcq_single',
  'mcq_single',
  'countdown_list',
  'put_in_order',
  'clue_chain',
];
const SPECIAL_QUESTION_CANDIDATE_LIMIT = 50;
// Safety ceiling: if a client never acks ready (dropped, bug, slow device), send
// the next question anyway so the match doesn't stall.
const GOAL_ROUND_READY_ACK_CEILING_MS = 12000;

const CLUES_POINTS_BY_INDEX = [200, 150, 100, 50, 25] as const;

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

function getNextQuestionDelayMs(params: {
  phase: PossessionStatePayload['phase'];
}): number {
  if (params.phase === 'PENALTY_SHOOTOUT') {
    return PENALTY_INTRO_DELAY_MS;
  }
  return ROUND_RESULT_DELAY_MS;
}

async function scheduleNextPossessionQuestion(
  io: QuizballServer,
  matchId: string,
  cache: MatchCache | null,
  params: {
    phase: PossessionStatePayload['phase'];
    resolvedQIndex: number;
    nextIndex: number;
    goalScoredBySeat: Seat | null;
  }
): Promise<void> {
  const { phase, resolvedQIndex, nextIndex, goalScoredBySeat } = params;
  const dispatch = (opts?: { postReadyAck?: boolean }) => {
    void sendPossessionMatchQuestion(io, matchId, nextIndex, opts).catch((error) => {
      logger.error({ error, matchId, nextIndex }, 'Failed to send next possession question');
    });
  };

  if (goalScoredBySeat && phase !== 'PENALTY_SHOOTOUT') {
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

// ── Helpers that stay in the main file ──

function emitChanceCardError(
  socket: QuizballSocket,
  payload: {
    matchId: string;
    qIndex: number;
    clientActionId: string;
  },
  code: 'CHANCE_CARD_NOT_AVAILABLE' | 'CHANCE_CARD_NOT_ALLOWED' | 'CHANCE_CARD_ALREADY_USED' | 'CHANCE_CARD_SYNC_FAILED',
  message: string
): void {
  socket.emit('error', {
    code,
    message,
    meta: {
      matchId: payload.matchId,
      qIndex: payload.qIndex,
      clientActionId: payload.clientActionId,
    },
  });
}

async function emitMatchState(io: QuizballServer, matchId: string, state: PossessionStatePayload): Promise<void> {
  io.to(`match:${matchId}`).emit('match:state', toMatchStatePayload(matchId, state));
}

export async function emitPossessionStateToSocket(socket: QuizballSocket, matchId: string): Promise<void> {
  const cache = await getMatchCacheOrRebuild(matchId);
  if (cache) {
    socket.emit('match:state', toMatchStatePayload(matchId, cache.statePayload));
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

function computeResumedPossessionTiming(params: {
  shownAtRaw: string | null;
  deadlineAtRaw: string | null;
  pauseStartedAtMs: number;
  resumedAtMs: number;
  qIndex: number;
  state: PossessionStatePayload;
  questionKind: MatchQuestionKind;
}): { playableAt: Date; deadlineAt: Date } {
  const shownAtMs = params.shownAtRaw ? new Date(params.shownAtRaw).getTime() : Number.NaN;
  const deadlineAtMs = params.deadlineAtRaw ? new Date(params.deadlineAtRaw).getTime() : Number.NaN;

  if (!Number.isFinite(shownAtMs) || !Number.isFinite(deadlineAtMs) || deadlineAtMs <= shownAtMs) {
    return buildPlayableQuestionTiming({
      qIndex: params.qIndex,
      state: params.state,
      questionKind: params.questionKind,
    });
  }

  const effectivePauseStartMs = Math.min(params.pauseStartedAtMs, deadlineAtMs);
  const revealRemainingMs = Math.max(0, shownAtMs - effectivePauseStartMs);
  const answerRemainingMs = Math.max(0, deadlineAtMs - effectivePauseStartMs);

  return {
    playableAt: new Date(params.resumedAtMs + revealRemainingMs),
    deadlineAt: new Date(params.resumedAtMs + answerRemainingMs),
  };
}

function toAuthoritativeTimeMs(
  questionTiming: {
    shown_at: string | null;
    deadline_at: string | null;
  },
  nowMs: number,
  fallbackTimeMs: number,
  questionTimeMs = QUESTION_TIME_MS
): number {
  return computeAuthoritativeTimeMs(
    { shownAt: questionTiming.shown_at, deadlineAt: questionTiming.deadline_at },
    nowMs,
    fallbackTimeMs,
    questionTimeMs
  );
}

function toAuthoritativeTimeMsFromCache(
  questionTiming: {
    shownAt: string | null;
    deadlineAt: string | null;
  },
  nowMs: number,
  fallbackTimeMs: number,
  questionTimeMs = QUESTION_TIME_MS
): number {
  return computeAuthoritativeTimeMs(questionTiming, nowMs, fallbackTimeMs, questionTimeMs);
}

function computeAuthoritativeTimeMs(
  questionTiming: {
    shownAt: string | null;
    deadlineAt: string | null;
  },
  nowMs: number,
  fallbackTimeMs: number,
  questionTimeMs = QUESTION_TIME_MS
): number {
  if (questionTiming.shownAt) {
    const shownAtMs = new Date(questionTiming.shownAt).getTime();
    if (Number.isFinite(shownAtMs)) {
      return clamp(Math.round(nowMs - shownAtMs), 0, questionTimeMs);
    }
  }

  if (questionTiming.deadlineAt) {
    const deadlineMs = new Date(questionTiming.deadlineAt).getTime();
    if (Number.isFinite(deadlineMs)) {
      return clamp(Math.round(questionTimeMs - (deadlineMs - nowMs)), 0, questionTimeMs);
    }
  }

  return clamp(Math.round(fallbackTimeMs), 0, questionTimeMs);
}

function fireAndForget(label: string, fn: () => Promise<unknown>): void {
  fn().catch((error) => {
    logger.error({ error, label }, 'Fire-and-forget DB write failed');
  });
}

function getUserIdByCachedSeat(players: CachedPlayer[], seat: CachedSeat): string | null {
  return players.find((player) => player.seat === seat)?.userId ?? null;
}

function toCachedAnswerByUserId(cache: MatchCache): Map<string, { is_correct: boolean; time_ms: number }> {
  return new Map(
    Object.entries(cache.answers).map(([userId, answer]) => [
      userId,
      {
        is_correct: answer.isCorrect,
        time_ms: answer.timeMs,
      },
    ])
  );
}

function buildPlayersPayloadFromCache(cache: MatchCache): Record<string, {
  selectedIndex: number | null;
  isCorrect: boolean;
  timeMs: number;
  pointsEarned: number;
  totalPoints: number;
  foundCount?: number;
  clueIndex?: number | null;
}> {
  const payload: Record<string, {
    selectedIndex: number | null;
    isCorrect: boolean;
    timeMs: number;
    pointsEarned: number;
    totalPoints: number;
    foundCount?: number;
    clueIndex?: number | null;
  }> = {};

  for (const player of cache.players) {
    const answer = cache.answers[player.userId];
    if (!answer) continue;
    payload[player.userId] = {
      selectedIndex: answer.selectedIndex,
      isCorrect: answer.isCorrect,
      timeMs: answer.timeMs,
      pointsEarned: answer.pointsEarned,
      totalPoints: player.totalPoints,
      foundCount: answer.foundCount,
      clueIndex: answer.clueIndex ?? null,
    };
  }
  return payload;
}

function questionTypeForState(state: PossessionStatePayload): QuestionType {
  if (state.phase === 'NORMAL_PLAY') {
    const slot = state.normalQuestionsAnsweredInHalf % POSSESSION_QUESTIONS_PER_HALF;
    return NORMAL_HALF_SEQUENCE[slot] ?? 'mcq_single';
  }

  return 'mcq_single';
}

function questionKindForType(type: QuestionType): MatchQuestionKind {
  switch (type) {
    case 'countdown_list':
      return 'countdown';
    case 'put_in_order':
      return 'putInOrder';
    case 'clue_chain':
      return 'clues';
    case 'mcq_single':
    case 'true_false':
    case 'input_text':
    default:
      return 'multipleChoice';
  }
}

function normalizeAnswer(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function levenshtein(left: string, right: string): number {
  const matrix: number[][] = [];
  for (let row = 0; row <= right.length; row += 1) {
    matrix[row] = [row];
  }
  for (let column = 0; column <= left.length; column += 1) {
    matrix[0][column] = column;
  }
  for (let row = 1; row <= right.length; row += 1) {
    for (let column = 1; column <= left.length; column += 1) {
      matrix[row][column] = right[row - 1] === left[column - 1]
        ? matrix[row - 1][column - 1]
        : Math.min(
            matrix[row - 1][column - 1] + 1,
            matrix[row][column - 1] + 1,
            matrix[row - 1][column] + 1
          );
    }
  }
  return matrix[right.length][left.length];
}

function fuzzyMatchesAnswer(input: string, acceptedAnswers: string[]): boolean {
  const normalizedInput = normalizeAnswer(input);
  if (!normalizedInput) return false;

  return acceptedAnswers.some((acceptedAnswer) => {
    const normalizedAccepted = normalizeAnswer(acceptedAnswer);
    if (!normalizedAccepted) return false;
    if (normalizedInput === normalizedAccepted) return true;
    if (normalizedInput.length >= 4 && normalizedAccepted.includes(normalizedInput)) return true;
    const maxDistance = normalizedAccepted.length > 6 ? 2 : 1;
    return levenshtein(normalizedInput, normalizedAccepted) <= maxDistance;
  });
}

const MIN_PREFIX_LENGTH = 3;

function countdownMatch(
  evaluation: Extract<MatchQuestionEvaluation, { kind: 'countdown' }>,
  guess: string,
  foundIds: Set<string>
): { id: string; display: Record<string, string> } | null {
  const normalizedGuess = normalizeAnswer(guess);
  if (!normalizedGuess) return null;

  // Priority 1: exact match or existing fuzzy match (fast path for full answers)
  for (const answerGroup of evaluation.answerGroups) {
    if (foundIds.has(answerGroup.id)) continue;
    if (fuzzyMatchesAnswer(guess, answerGroup.acceptedAnswers)) {
      return {
        id: answerGroup.id,
        display: answerGroup.display,
      };
    }
  }

  // Priority 2: unique prefix match (3+ chars, must match exactly one unfound group)
  if (normalizedGuess.length >= MIN_PREFIX_LENGTH) {
    const prefixCandidates: Array<{ id: string; display: Record<string, string> }> = [];
    for (const answerGroup of evaluation.answerGroups) {
      if (foundIds.has(answerGroup.id)) continue;
      const hasPrefix = answerGroup.acceptedAnswers.some((accepted) =>
        normalizeAnswer(accepted).startsWith(normalizedGuess)
      );
      if (hasPrefix) {
        prefixCandidates.push({ id: answerGroup.id, display: answerGroup.display });
      }
    }
    if (prefixCandidates.length === 1) {
      return prefixCandidates[0];
    }
  }

  return null;
}

function clueIndexForTimeMs(clueCount: number, timeMs: number, questionTimeMs: number): number {
  if (clueCount <= 1) return 0;
  const sliceMs = questionTimeMs / clueCount;
  return clamp(Math.floor(timeMs / sliceMs), 0, clueCount - 1);
}

function toCachedPlayers(rows: Array<{
  user_id: string;
  seat: number;
  total_points: number;
  correct_answers: number;
  goals: number;
  penalty_goals: number;
  avg_time_ms: number | null;
}>): CachedPlayer[] {
  return rows.map((row) => ({
    userId: row.user_id,
    seat: row.seat === 2 ? 2 : 1,
    totalPoints: row.total_points,
    correctAnswers: row.correct_answers,
    goals: row.goals,
    penaltyGoals: row.penalty_goals,
    avgTimeMs: row.avg_time_ms,
  }));
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

async function getExpectedAnswersForQuestion(matchId: string, qIndex: number): Promise<ExpectedAnswerInfo | null> {
  const question = await matchesRepo.getMatchQuestion(matchId, qIndex);
  if (!question) return null;

  const players = await matchesRepo.listMatchPlayers(matchId);
  const shooterSeat = asSeat(question.shooter_seat);
  const attackerSeat = asSeat(question.attacker_seat);

  if (question.phase_kind === 'penalty' && shooterSeat) {
    const shooterUserId = getUserIdBySeat(players, shooterSeat);
    const keeperSeat = shooterSeat === 1 ? 2 : 1;
    const keeperUserId = getUserIdBySeat(players, keeperSeat);
    const expectedUserIds = [shooterUserId, keeperUserId].filter((id): id is string => id !== null);
    return {
      expectedUserIds,
      shooterSeat,
      attackerSeat,
    };
  }

  return {
    expectedUserIds: players.map((player) => player.user_id),
    shooterSeat,
    attackerSeat,
  };
}

function applyDeltaAndGoalCheck(
  state: PossessionStatePayload,
  seat1Points: number,
  seat2Points: number
): { delta: number; goalScoredBySeat: Seat | null } {
  const delta = seat1Points - seat2Points;
  const nextDiff = state.possessionDiff + delta;

  if (nextDiff >= 100) {
    state.possessionDiff = 0;
    state.goals.seat1 += 1;
    state.kickOffSeat = 2;
    return { delta, goalScoredBySeat: 1 };
  }

  if (nextDiff <= -100) {
    state.possessionDiff = 0;
    state.goals.seat2 += 1;
    state.kickOffSeat = 1;
    return { delta, goalScoredBySeat: 2 };
  }

  state.possessionDiff = clamp(nextDiff, -99, 99);
  return { delta, goalScoredBySeat: null };
}

function beginSecondHalf(state: PossessionStatePayload): void {
  state.half = 2;
  state.phase = 'NORMAL_PLAY';
  state.possessionDiff = 0;
  state.kickOffSeat = nextSeat(state.kickOffSeat);
  state.lastAttack.attackerSeat = null;
  state.halftime.deadlineAt = null;
  state.halftime.categoryOptions = [];
  state.halftime.firstHalfShownCategoryIds = [];
  state.halftime.firstBanSeat = null;
  state.halftime.bans = { seat1: null, seat2: null };
  state.currentQuestion = null;
  state.normalQuestionsAnsweredInHalf = 0;
}

function transitionAfterHalfBoundary(
  state: PossessionStatePayload,
  options?: { presetSecondHalfCategoryId?: string | null }
): void {
  if (state.half === 1) {
    if (options?.presetSecondHalfCategoryId) {
      beginSecondHalf(state);
      return;
    }

    state.phase = 'HALFTIME';
    state.halftime.deadlineAt = new Date(Date.now() + HALFTIME_DURATION_MS).toISOString();
    return;
  }

  if (state.goals.seat1 === state.goals.seat2) {
    state.phase = 'PENALTY_SHOOTOUT';
    state.penalty.round = 1;
    state.penalty.shooterSeat = 1;
    state.penalty.suddenDeath = false;
    state.penalty.kicksTaken = { seat1: 0, seat2: 0 };
    return;
  }

  state.phase = 'COMPLETED';
}

function decideWinner(
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

async function completePossessionMatch(
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

function categoryIdsForCurrentHalf(
  state: Pick<PossessionStatePayload, 'half'>,
  cache: Pick<MatchCache, 'categoryAId' | 'categoryBId'>
): string[] {
  if (state.half === 1) return [cache.categoryAId];
  return cache.categoryBId ? [cache.categoryBId] : [cache.categoryAId];
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

function applyNormalResolution(
  state: PossessionStatePayload,
  seat1Points: number,
  seat2Points: number,
  seat1Correct: boolean,
  seat2Correct: boolean,
  presetSecondHalfCategoryId?: string | null
): { delta: number; goalScoredBySeat: Seat | null } {
  const result = applyDeltaAndGoalCheck(state, seat1Points, seat2Points);
  state.normalQuestionsAnsweredInHalf += 1;
  state.normalQuestionsAnsweredTotal += 1;

  if (state.normalQuestionsAnsweredInHalf >= state.normalQuestionsPerHalf) {
    if (state.possessionDiff >= 50) {
      // Last attack is awarded only if the attacking side (seat 1) answered correctly
      // while the defending side (seat 2) failed on the boundary question.
      if (seat1Correct && !seat2Correct) {
        state.phase = 'LAST_ATTACK';
        state.lastAttack.attackerSeat = 1;
        return result;
      }
    } else if (state.possessionDiff <= -50) {
      // Mirrored condition for seat 2 attacking.
      if (seat2Correct && !seat1Correct) {
        state.phase = 'LAST_ATTACK';
        state.lastAttack.attackerSeat = 2;
        return result;
      }
    }
    state.lastAttack.attackerSeat = null;
    transitionAfterHalfBoundary(state, { presetSecondHalfCategoryId });
    return result;
  }

  state.phase = 'NORMAL_PLAY';
  state.lastAttack.attackerSeat = null;
  return result;
}

function applyLastAttackResolution(
  state: PossessionStatePayload,
  seat1Points: number,
  seat2Points: number,
  presetSecondHalfCategoryId?: string | null
): { delta: number; goalScoredBySeat: Seat | null } {
  const result = applyDeltaAndGoalCheck(state, seat1Points, seat2Points);
  state.lastAttack.attackerSeat = null;
  transitionAfterHalfBoundary(state, { presetSecondHalfCategoryId });
  return result;
}

function penaltyWinnerSeat(state: PossessionStatePayload): Seat | null {
  const p1 = state.penaltyGoals.seat1;
  const p2 = state.penaltyGoals.seat2;
  const k1 = state.penalty.kicksTaken.seat1;
  const k2 = state.penalty.kicksTaken.seat2;

  // Sudden death: only decide after both players have kicked equally
  if (state.penalty.suddenDeath) {
    if (k1 === k2 && p1 !== p2) {
      return p1 > p2 ? 1 : 2;
    }
    return null;
  }

  // Regular rounds (1-5): clinch if one side can't catch up
  const rem1 = Math.max(0, 5 - k1);
  const rem2 = Math.max(0, 5 - k2);

  if (p1 > p2 + rem2) return 1;
  if (p2 > p1 + rem1) return 2;

  // All 5 kicks taken by both, scores differ
  if (k1 >= 5 && k2 >= 5 && p1 !== p2) {
    return p1 > p2 ? 1 : 2;
  }

  return null;
}

function applyPenaltyResolution(
  state: PossessionStatePayload,
  players: CachedPlayer[],
  answerByUserId: Map<string, { is_correct: boolean; time_ms: number }>,
  shooterSeat: Seat
): { goalScoredByUserId: string | null } {
  const keeperSeat = nextSeat(shooterSeat);
  const shooterUserId = getUserIdByCachedSeat(players, shooterSeat);
  const keeperUserId = getUserIdByCachedSeat(players, keeperSeat);
  if (!shooterUserId) {
    state.phase = 'COMPLETED';
    state.currentQuestion = null;
    return { goalScoredByUserId: null };
  }

  const shooterAnswer = answerByUserId.get(shooterUserId);
  const keeperAnswer = answerByUserId.get(keeperUserId ?? '');
  const shooterCorrect = shooterAnswer?.is_correct ?? false;
  const keeperCorrect = keeperAnswer?.is_correct ?? false;
  const shooterTimeMs = shooterAnswer?.time_ms ?? QUESTION_TIME_MS;
  const keeperTimeMs = keeperAnswer?.time_ms ?? QUESTION_TIME_MS;

  // Penalty duel logic:
  // - Shooter wrong → miss
  // - Shooter correct, keeper wrong → goal
  // - Both correct → faster player wins
  // - Both wrong → miss
  let isGoal = false;
  if (shooterCorrect && !keeperCorrect) {
    isGoal = true;
  } else if (shooterCorrect && keeperCorrect) {
    isGoal = shooterTimeMs < keeperTimeMs;
  }

  let goalScoredByUserId: string | null = null;
  if (isGoal) {
    if (shooterSeat === 1) state.penaltyGoals.seat1 += 1;
    else state.penaltyGoals.seat2 += 1;
    const shooter = players.find((player) => player.userId === shooterUserId);
    if (shooter) shooter.penaltyGoals += 1;
    goalScoredByUserId = shooterUserId;
  }

  if (shooterSeat === 1) state.penalty.kicksTaken.seat1 += 1;
  else state.penalty.kicksTaken.seat2 += 1;

  const winnerSeat = penaltyWinnerSeat(state);
  if (winnerSeat) {
    state.phase = 'COMPLETED';
    state.currentQuestion = null;
    return { goalScoredByUserId };
  }

  state.phase = 'PENALTY_SHOOTOUT';
  state.penalty.round += 1;
  state.penalty.shooterSeat = nextSeat(shooterSeat);
  if (
    state.penalty.kicksTaken.seat1 >= 5 &&
    state.penalty.kicksTaken.seat2 >= 5 &&
    state.penaltyGoals.seat1 === state.penaltyGoals.seat2
  ) {
    state.penalty.suddenDeath = true;
  }
  state.currentQuestion = null;
  return { goalScoredByUserId };
}

async function resolvePossessionRoundDbPath(
  io: QuizballServer,
  matchId: string,
  qIndex: number,
  fromTimeout = false
): Promise<void> {
  await withSpan('match.possession.resolve_round', {
    'quizball.match_id': matchId,
    'quizball.q_index': qIndex,
    'quizball.from_timeout': fromTimeout,
  }, async (span) => {
    const startedAt = Date.now();
    const lockKey = `lock:match:${matchId}:resolve`;
    const lock = await acquireLock(lockKey, 5000);
    if (!lock.acquired || !lock.token) {
      span.setAttribute('quizball.resolve_lock_acquired', false);
      return;
    }
    span.setAttribute('quizball.resolve_lock_acquired', true);

    try {
      const match = await matchesRepo.getMatch(matchId);
      if (!match || match.status !== 'active') return;
      if (match.current_q_index > qIndex) return;

      // Parallelize independent reads for speed
      const [questionPayload, expected, players, answers] = await Promise.all([
        matchesService.buildMatchQuestionPayload(matchId, qIndex),
        getExpectedAnswersForQuestion(matchId, qIndex),
        matchesRepo.listMatchPlayers(matchId),
        matchesRepo.listAnswersForQuestion(matchId, qIndex),
      ]);
      if (!questionPayload) return;
      if (!expected) return;

      span.setAttributes({
        'quizball.phase_kind': questionPayload.phaseKind,
        'quizball.phase_round': questionPayload.phaseRound ?? 0,
        'quizball.expected_answers': expected.expectedUserIds.length,
        'quizball.answers_received': answers.length,
      });

      const answeredUserIds = new Set(answers.map((answer) => answer.user_id));

      if (!fromTimeout && answers.length < expected.expectedUserIds.length) {
        return;
      }

      for (const userId of expected.expectedUserIds) {
        if (answeredUserIds.has(userId)) continue;
        await matchesRepo.insertMatchAnswerIfMissing({
          matchId,
          qIndex,
          userId,
          selectedIndex: null,
          isCorrect: false,
          timeMs: getQuestionDurationMs(
            questionPayload.question.kind,
            questionPayload.question.kind === 'clues' ? questionPayload.question.clues.length : undefined
          ),
          pointsEarned: 0,
          phaseKind: questionPayload.phaseKind,
          phaseRound: questionPayload.phaseRound,
          shooterSeat: questionPayload.shooterSeat,
        });
      }

      // When not from timeout, all answers were already present (no backfill) — reuse cached data
      const finalAnswers = fromTimeout
        ? await matchesRepo.listAnswersForQuestion(matchId, qIndex)
        : answers;
      const playerRows = fromTimeout
        ? await matchesRepo.listMatchPlayers(matchId)
        : players;

      const playersPayload: Record<string, {
        selectedIndex: number | null;
        isCorrect: boolean;
        timeMs: number;
        pointsEarned: number;
        totalPoints: number;
      }> = {};

      for (const answer of finalAnswers) {
        const player = playerRows.find((row) => row.user_id === answer.user_id);
        if (!player) continue;
        playersPayload[answer.user_id] = {
          selectedIndex: answer.selected_index,
          isCorrect: answer.is_correct,
          timeMs: answer.time_ms,
          pointsEarned: answer.points_earned,
          totalPoints: player.total_points,
        };
      }

      // ── Snapshot state BEFORE mutations ──
      const state = parsePossessionState(match.state_payload);
      const prevPenGoalsSeat1 = state.penaltyGoals.seat1;
      const prevPenGoalsSeat2 = state.penaltyGoals.seat2;

      const answerByUserId = new Map(finalAnswers.map((answer) => [
        answer.user_id,
        {
          is_correct: answer.is_correct,
          time_ms: answer.time_ms,
          points_earned: answer.points_earned,
        },
      ]));

      let possessionDelta = 0;
      let goalScoredBySeat: Seat | null = null;

      // ── Apply mutations ──
      if (questionPayload.phaseKind === 'normal' || questionPayload.phaseKind === 'last_attack') {
        const seat1UserId = getUserIdBySeat(players, 1);
        const seat2UserId = getUserIdBySeat(players, 2);
        const seat1Answer = seat1UserId
          ? answerByUserId.get(seat1UserId)
          : undefined;
        const seat2Answer = seat2UserId
          ? answerByUserId.get(seat2UserId)
          : undefined;
        const seat1Points = seat1UserId
          ? (seat1Answer?.points_earned ?? 0)
          : 0;
        const seat2Points = seat2UserId
          ? (seat2Answer?.points_earned ?? 0)
          : 0;
        const result = questionPayload.phaseKind === 'normal'
          ? applyNormalResolution(
            state,
            seat1Points,
            seat2Points,
            seat1Answer?.is_correct ?? false,
            seat2Answer?.is_correct ?? false,
            match.category_b_id
          )
          : applyLastAttackResolution(state, seat1Points, seat2Points, match.category_b_id);
        possessionDelta = result.delta;
        goalScoredBySeat = result.goalScoredBySeat;
        if (result.goalScoredBySeat) {
          const goalScoredByUserId = getUserIdBySeat(players, result.goalScoredBySeat);
          if (goalScoredByUserId) {
            await matchesRepo.updatePlayerGoalTotals(matchId, goalScoredByUserId, { goals: 1 });
          }
        }
      } else {
        const penaltyOutcome = applyPenaltyResolution(
          state,
          toCachedPlayers(players),
          new Map(finalAnswers.map((answer) => [answer.user_id, { is_correct: answer.is_correct, time_ms: answer.time_ms }])),
          asSeat(questionPayload.shooterSeat) ?? state.penalty.shooterSeat
        );
        if (penaltyOutcome.goalScoredByUserId) {
          await matchesRepo.updatePlayerGoalTotals(matchId, penaltyOutcome.goalScoredByUserId, { penaltyGoals: 1 });
        }
      }

      state.currentQuestion = null;

    // ── Compute deltas (post-mutation minus pre-mutation) ──
    const deltas: MatchRoundResultDeltas = {
      possessionDelta,
      penaltyOutcome: null,
      goalScoredBySeat,
    };

    if (questionPayload.phaseKind === 'penalty') {
      const penDiff1 = state.penaltyGoals.seat1 - prevPenGoalsSeat1;
      const penDiff2 = state.penaltyGoals.seat2 - prevPenGoalsSeat2;
      if (penDiff1 > 0 || penDiff2 > 0) {
        deltas.penaltyOutcome = 'goal';
        deltas.goalScoredBySeat = penDiff1 > 0 ? 1 : 2;
      } else {
        deltas.penaltyOutcome = 'saved';
      }
    }

    // ── Emit round_result with deltas (AFTER mutations) ──
    io.to(`match:${matchId}`).emit('match:round_result', {
      matchId,
      qIndex,
      questionKind: questionPayload.question.kind,
      reveal: questionPayload.reveal,
      players: playersPayload,
      phaseKind: questionPayload.phaseKind,
      phaseRound: questionPayload.phaseRound,
      shooterSeat: questionPayload.shooterSeat,
      attackerSeat: questionPayload.attackerSeat,
      deltas,
    });

    if (state.phase === 'HALFTIME') {
      const halfOneCategoryId = typeof match.category_a_id === 'string'
        ? match.category_a_id
        : questionPayload.categoryId;
      await ensureHalftimeCategories(state, halfOneCategoryId, matchId);
    }

    // ── Persist and emit state ──
    const nextIndex = qIndex + 1;
    bumpStateVersion(state);
	    await matchesRepo.setMatchStatePayload(matchId, state, nextIndex);
	    await emitMatchState(io, matchId, state);
        appMetrics.roundResolutionDuration.record(Date.now() - startedAt, {
          mode: match.mode,
          variant: state.variant,
          phase_kind: questionPayload.phaseKind,
        });

	    if (state.phase === 'HALFTIME') {
      scheduleHalftimeTimeout(io, matchId);
      schedulePossessionAiHalftimeBan(io, matchId);
      return;
    }

    if (state.phase === 'COMPLETED') {
      await completePossessionMatch(io, matchId, state);
      return;
    }

    await scheduleNextPossessionQuestion(io, matchId, null, {
      phase: state.phase,
      resolvedQIndex: qIndex,
      nextIndex,
      goalScoredBySeat,
    });
    } finally {
      await releaseLock(lockKey, lock.token);
      clearQuestionTimer(matchId, qIndex);
      clearAiAnswerTimer(matchId, qIndex);
    }
  });
}

async function handlePossessionAnswerDbPath(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: {
    matchId: string;
    qIndex: number;
    selectedIndex: number | null;
    timeMs: number;
  }
): Promise<void> {
  const { matchId, qIndex, selectedIndex, timeMs } = payload;

  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'active') {
    return;
  }

  if (match.current_q_index !== qIndex) {
    return;
  }

  // Parallelize independent reads: players, question payload, duplicate check, timing
  const [players, rawQuestionPayload, existing, questionTiming] = await Promise.all([
    matchesRepo.listMatchPlayers(matchId),
    matchesService.buildMatchQuestionPayload(matchId, qIndex),
    matchesRepo.getAnswerForUser(matchId, qIndex, socket.data.user.id),
    matchesRepo.getMatchQuestionTiming(matchId, qIndex),
  ]);

  const mySeat = getSeatFromUserId(players, socket.data.user.id);
  const questionPayload = normalizeMatchQuestionPayload(rawQuestionPayload);
  if (!mySeat) return;
  if (!questionPayload) return;
  if (existing) return;

  if (questionPayload.phaseKind === 'penalty') {
    const shooterSeat = asSeat(questionPayload.shooterSeat);
    const keeperSeat = shooterSeat === 1 ? 2 : 1;
    if (mySeat !== shooterSeat && mySeat !== keeperSeat) {
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'Only the shooter or keeper can answer this penalty question.',
      });
      return;
    }
  }

  const correctIndex = getMultipleChoiceCorrectIndexFromPayload(questionPayload);
  if (correctIndex === null) {
    socket.emit('error', {
      code: 'MATCH_NOT_ALLOWED',
      message: 'This question type requires a dedicated answer event.',
    });
    return;
  }

  const authoritativeTimeMs = questionTiming
    ? toAuthoritativeTimeMs(questionTiming, Date.now(), timeMs, getQuestionDurationMs(questionPayload.question.kind))
    : clamp(timeMs, 0, getQuestionDurationMs(questionPayload.question.kind));
  const clientTimeMs = clamp(timeMs, 0, getQuestionDurationMs(questionPayload.question.kind));
  const diffMs = Math.abs(authoritativeTimeMs - clientTimeMs);
  if (diffMs > TIMING_DISCREPANCY_WARN_MS) {
    logger.warn(
      {
        matchId,
        qIndex,
        userId: socket.data.user.id,
        serverTimeMs: authoritativeTimeMs,
        clientTimeMs,
        diffMs,
      },
      'Match answer timing discrepancy detected'
    );
  }

  const isCorrect = selectedIndex !== null && selectedIndex === correctIndex;
  const pointsEarned = calculatePoints(
    isCorrect,
    authoritativeTimeMs,
    getQuestionDurationMs(questionPayload.question.kind)
  );

  await matchesRepo.insertMatchAnswer({
    matchId,
    qIndex,
    userId: socket.data.user.id,
    selectedIndex,
    isCorrect,
    timeMs: authoritativeTimeMs,
    pointsEarned,
    phaseKind: questionPayload.phaseKind,
    phaseRound: questionPayload.phaseRound,
    shooterSeat: questionPayload.shooterSeat,
  });

  const updatedPlayer = await matchesRepo.updatePlayerTotals(
    matchId,
    socket.data.user.id,
    pointsEarned,
    isCorrect
  );
  if (!updatedPlayer) return;

  // Parallelize: check expected answers + count submitted answers
  const [expected, answers] = await Promise.all([
    getExpectedAnswersForQuestion(matchId, qIndex),
    matchesRepo.listAnswersForQuestion(matchId, qIndex),
  ]);

  const shouldWaitForOpponent = expected
    ? expected.expectedUserIds.length > 1 && answers.length < expected.expectedUserIds.length
    : false;

  socket.emit('match:answer_ack', {
    matchId,
    qIndex,
    questionKind: questionPayload.question.kind,
    selectedIndex,
    isCorrect,
    correctIndex,
    myTotalPoints: updatedPlayer.total_points,
    oppAnswered: !shouldWaitForOpponent,
    pointsEarned,
    phaseKind: questionPayload.phaseKind,
    phaseRound: questionPayload.phaseRound,
    shooterSeat: questionPayload.shooterSeat,
  });

  if (questionPayload.phaseKind !== 'penalty') {
    socket.to(`match:${matchId}`).emit('match:opponent_answered', {
      matchId,
      qIndex,
      questionKind: questionPayload.question.kind,
      opponentTotalPoints: updatedPlayer.total_points,
      pointsEarned,
      isCorrect,
      selectedIndex,
    });
  }

  if (expected && answers.length >= expected.expectedUserIds.length) {
    await resolvePossessionRound(io, matchId, qIndex, false);
  }
}

export async function resolvePossessionRound(
  io: QuizballServer,
  matchId: string,
  qIndex: number,
  fromTimeout = false
): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) {
    await resolvePossessionRoundDbPath(io, matchId, qIndex, fromTimeout);
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
          foundCount: question.kind === 'countdown' ? 0 : undefined,
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
            selectedIndex: answer.selectedIndex,
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
      fireAndForget('updatePlayerGoalTotals(resolve)', async () => {
        const MAX_RETRIES = 3;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            if (goalScoredByUserId) {
              await matchesRepo.updatePlayerGoalTotals(matchId, goalScoredByUserId, delta);
            }
            return;
          } catch (err) {
            if (attempt === MAX_RETRIES) {
              logger.error(
                { error: err, matchId, userId: goalScoredByUserId, delta, phaseKind: question.phaseKind },
                'updatePlayerGoalTotals failed after retries'
              );
              return;
            }
            await new Promise((r) => setTimeout(r, 100 * 2 ** (attempt - 1)));
          }
        }
      });
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

export async function handlePossessionAnswer(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: {
    matchId: string;
    qIndex: number;
    selectedIndex: number | null;
    timeMs: number;
  }
): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) {
    await handlePossessionAnswerDbPath(io, socket, payload);
    return;
  }

  const { matchId, qIndex, selectedIndex, timeMs } = payload;
  const lockKey = `lock:match:${matchId}:answer`;
  const lock = await acquireLock(lockKey, 2000);
  if (!lock.acquired || !lock.token) {
    socket.emit('error', {
      code: 'MATCH_BUSY',
      message: 'Match is busy. Please retry answer submission.',
    });
    return;
  }

  let committed: {
    question: NonNullable<MatchCache['currentQuestion']>;
    isCorrect: boolean;
    pointsEarned: number;
    answerTimeMs: number;
    myTotalPoints: number;
    expectedCount: number;
    answerCount: number;
  } | null = null;

  try {
    const cache = await getMatchCacheOrRebuild(matchId);
    if (!cache || cache.status !== 'active') return;
    if (cache.currentQIndex !== qIndex) return;
    if (!cache.currentQuestion || cache.currentQuestion.qIndex !== qIndex) return;

    const player = getCachedPlayer(cache, socket.data.user.id);
    if (!player) return;
    if (hasUserAnswered(cache, socket.data.user.id)) return;

    const question = cache.currentQuestion;
    if (question.phaseKind === 'penalty') {
      const shooterSeat = asSeat(question.shooterSeat);
      const keeperSeat = shooterSeat === 1 ? 2 : 1;
      if (player.seat !== shooterSeat && player.seat !== keeperSeat) {
        socket.emit('error', {
          code: 'MATCH_NOT_ALLOWED',
          message: 'Only the shooter or keeper can answer this penalty question.',
        });
        return;
      }
    }

    if (question.kind !== 'multipleChoice' || question.evaluation.kind !== 'multipleChoice') {
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'This question type requires a dedicated answer event.',
      });
      return;
    }

    const authoritativeTimeMs = toAuthoritativeTimeMsFromCache(
      {
        shownAt: question.shownAt,
        deadlineAt: question.deadlineAt,
      },
      Date.now(),
      timeMs,
      getQuestionDurationMs(question.kind)
    );
    const clientTimeMs = clamp(timeMs, 0, getQuestionDurationMs(question.kind));
    const diffMs = Math.abs(authoritativeTimeMs - clientTimeMs);
    if (diffMs > TIMING_DISCREPANCY_WARN_MS) {
      logger.warn(
        {
          matchId,
          qIndex,
          userId: socket.data.user.id,
          serverTimeMs: authoritativeTimeMs,
          clientTimeMs,
          diffMs,
        },
        'Match answer timing discrepancy detected'
      );
    }
    const isCorrect = selectedIndex !== null && selectedIndex === question.evaluation.correctIndex;
    const pointsEarned = calculatePoints(isCorrect, authoritativeTimeMs, getQuestionDurationMs(question.kind));

    const answer: CachedAnswer = {
      userId: socket.data.user.id,
      questionKind: question.kind,
      selectedIndex,
      isCorrect,
      timeMs: authoritativeTimeMs,
      pointsEarned,
      phaseKind: question.phaseKind,
      phaseRound: question.phaseRound,
      shooterSeat: question.shooterSeat,
      answeredAt: new Date().toISOString(),
    };

    cache.answers[socket.data.user.id] = answer;
    player.totalPoints += pointsEarned;
    if (isCorrect) player.correctAnswers += 1;

    const expectedCount = getExpectedUserIds(cache).length;
    const currentAnswerCount = answerCount(cache);

    await setMatchCache(cache);

    committed = {
      question,
      isCorrect,
      pointsEarned,
      answerTimeMs: authoritativeTimeMs,
      myTotalPoints: player.totalPoints,
      expectedCount,
      answerCount: currentAnswerCount,
    };
  } finally {
    await releaseLock(lockKey, lock.token);
  }

  if (!committed) return;

  const shouldWaitForOpponent = committed.expectedCount > 1 && committed.answerCount < committed.expectedCount;

  fireAndForget('insertMatchAnswer(handlePossessionAnswer)', async () => {
    await matchesRepo.insertMatchAnswerIfMissing({
      matchId,
      qIndex,
      userId: socket.data.user.id,
      selectedIndex,
      isCorrect: committed.isCorrect,
      timeMs: committed.answerTimeMs,
      pointsEarned: committed.pointsEarned,
      phaseKind: committed.question.phaseKind,
      phaseRound: committed.question.phaseRound,
      shooterSeat: committed.question.shooterSeat,
    });
  });
  fireAndForget('updatePlayerTotals(handlePossessionAnswer)', async () => {
    await matchesRepo.updatePlayerTotals(
      matchId,
      socket.data.user.id,
      committed.pointsEarned,
      committed.isCorrect
    );
  });

  socket.emit('match:answer_ack', {
    matchId,
    qIndex,
    questionKind: committed.question.kind,
    selectedIndex,
    isCorrect: committed.isCorrect,
    correctIndex: getCachedMultipleChoiceCorrectIndex(committed.question) ?? undefined,
    myTotalPoints: committed.myTotalPoints,
    oppAnswered: !shouldWaitForOpponent,
    pointsEarned: committed.pointsEarned,
    phaseKind: committed.question.phaseKind,
    phaseRound: committed.question.phaseRound,
    shooterSeat: committed.question.shooterSeat,
  });

  if (committed.question.phaseKind !== 'penalty') {
    socket.to(`match:${matchId}`).emit('match:opponent_answered', {
      matchId,
      qIndex,
      questionKind: committed.question.kind,
      opponentTotalPoints: committed.myTotalPoints,
      pointsEarned: committed.pointsEarned,
      isCorrect: committed.isCorrect,
      selectedIndex,
    });
  }

  if (committed.answerCount >= committed.expectedCount) {
    await resolvePossessionRound(io, matchId, qIndex, false);
  }
}

export async function handlePossessionCountdownGuess(
  socket: QuizballSocket,
  payload: {
    matchId: string;
    qIndex: number;
    guess: string;
  }
): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) {
    socket.emit('error', {
      code: 'MATCH_UNAVAILABLE',
      message: 'Countdown questions require Redis-backed realtime state.',
    });
    return;
  }

  const { matchId, qIndex, guess } = payload;
  const userId = socket.data.user.id;

  // Read shared cache (read-only) to get question data and validate state.
  const cache = await getMatchCacheOrRebuild(matchId);
  if (!cache || cache.status !== 'active') return;
  if (cache.currentQIndex !== qIndex || !cache.currentQuestion || cache.currentQuestion.qIndex !== qIndex) return;

  const player = getCachedPlayer(cache, userId);
  if (!player) return;

  const question = cache.currentQuestion;
  if (question.kind !== 'countdown' || question.evaluation.kind !== 'countdown') {
    socket.emit('error', {
      code: 'MATCH_NOT_ALLOWED',
      message: 'The active question is not a countdown round.',
    });
    return;
  }

  // Read this player's per-player countdown state (Redis Set — no lock needed between players).
  const alreadyFound = await countdownGetFound(matchId, userId);
  const foundIds = new Set(alreadyFound);

  const matched = countdownMatch(question.evaluation, guess, foundIds);
  if (!matched) {
    socket.emit('match:countdown_guess_ack', {
      matchId,
      qIndex,
      accepted: false,
      duplicate: false,
      foundCount: foundIds.size,
    });
    return;
  }

  // Atomically add the found answer group ID via Lua script (handles duplicates).
  const addResult = await countdownAddFound(matchId, userId, matched.id);
  if (!addResult.added) {
    socket.emit('match:countdown_guess_ack', {
      matchId,
      qIndex,
      accepted: false,
      duplicate: true,
      foundCount: addResult.foundCount,
    });
    return;
  }

  socket.emit('match:countdown_guess_ack', {
    matchId,
    qIndex,
    accepted: true,
    duplicate: false,
    foundCount: addResult.foundCount,
    acceptedDisplay: matched.display,
  });
}

export async function handlePossessionPutInOrderAnswer(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: {
    matchId: string;
    qIndex: number;
    orderedItemIds: string[];
    timeMs: number;
  }
): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) {
    socket.emit('error', {
      code: 'MATCH_UNAVAILABLE',
      message: 'Put-in-order questions require Redis-backed realtime state.',
    });
    return;
  }

  const { matchId, qIndex, orderedItemIds, timeMs } = payload;
  const lockKey = `lock:match:${matchId}:put_in_order_answer`;
  const lock = await acquireLock(lockKey, 2000);
  if (!lock.acquired || !lock.token) {
    socket.emit('error', {
      code: 'MATCH_BUSY',
      message: 'Match is busy. Please retry answer submission.',
    });
    return;
  }

  let committed: {
    question: NonNullable<MatchCache['currentQuestion']>;
    isCorrect: boolean;
    pointsEarned: number;
    answerTimeMs: number;
    myTotalPoints: number;
    expectedCount: number;
    answerCount: number;
  } | null = null;

  try {
    const cache = await getMatchCacheOrRebuild(matchId);
    if (!cache || cache.status !== 'active') return;
    if (cache.currentQIndex !== qIndex || !cache.currentQuestion || cache.currentQuestion.qIndex !== qIndex) return;

    const player = getCachedPlayer(cache, socket.data.user.id);
    if (!player) return;
    if (hasUserAnswered(cache, socket.data.user.id)) return;

    const question = cache.currentQuestion;
    if (question.kind !== 'putInOrder' || question.evaluation.kind !== 'putInOrder') {
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'The active question is not a put-in-order round.',
      });
      return;
    }

    const evaluation = question.evaluation;
    // sort_value represents rank/position (1 = first in correct order).
    const correctOrderIds = [...evaluation.items]
      .sort((left, right) => left.sortValue - right.sortValue)
      .map((item) => item.id);
    const isCorrect = orderedItemIds.length === correctOrderIds.length
      && orderedItemIds.every((itemId, index) => correctOrderIds[index] === itemId);

    const authoritativeTimeMs = toAuthoritativeTimeMsFromCache(
      {
        shownAt: question.shownAt,
        deadlineAt: question.deadlineAt,
      },
      Date.now(),
      timeMs,
      getQuestionDurationMs(question.kind)
    );
    const pointsEarned = isCorrect
      ? calculatePoints(true, authoritativeTimeMs, getQuestionDurationMs(question.kind))
      : 0;

    cache.answers[socket.data.user.id] = {
      userId: socket.data.user.id,
      questionKind: question.kind,
      selectedIndex: null,
      isCorrect,
      timeMs: authoritativeTimeMs,
      pointsEarned,
      phaseKind: question.phaseKind,
      phaseRound: question.phaseRound,
      shooterSeat: question.shooterSeat,
      answeredAt: new Date().toISOString(),
      submittedOrderIds: orderedItemIds,
    };

    const expectedCount = getExpectedUserIds(cache).length;
    const currentAnswerCount = answerCount(cache);
    await setMatchCache(cache);

    committed = {
      question,
      isCorrect,
      pointsEarned,
      answerTimeMs: authoritativeTimeMs,
      myTotalPoints: player.totalPoints,
      expectedCount,
      answerCount: currentAnswerCount,
    };
  } finally {
    await releaseLock(lockKey, lock.token);
  }

  if (!committed) return;

  const shouldWaitForOpponent = committed.expectedCount > 1 && committed.answerCount < committed.expectedCount;

  socket.emit('match:answer_ack', {
    matchId,
    qIndex,
    questionKind: committed.question.kind,
    selectedIndex: null,
    isCorrect: committed.isCorrect,
    myTotalPoints: committed.myTotalPoints,
    oppAnswered: !shouldWaitForOpponent,
    pointsEarned: committed.pointsEarned,
    phaseKind: committed.question.phaseKind,
    phaseRound: committed.question.phaseRound,
    shooterSeat: committed.question.shooterSeat,
  });

  if (committed.question.phaseKind !== 'penalty') {
    socket.to(`match:${matchId}`).emit('match:opponent_answered', {
      matchId,
      qIndex,
      questionKind: committed.question.kind,
      opponentTotalPoints: committed.myTotalPoints,
      pointsEarned: committed.pointsEarned,
      isCorrect: committed.isCorrect,
      selectedIndex: null,
    });
  }

  if (committed.answerCount >= committed.expectedCount) {
    await resolvePossessionRound(io, matchId, qIndex, false);
  }
}

export async function handlePossessionCluesAnswer(
  io: QuizballServer,
  socket: QuizballSocket,
  payload:
    | {
        kind: 'guess';
        matchId: string;
        qIndex: number;
        guess: string;
        timeMs: number;
      }
    | {
        kind: 'giveUp';
        matchId: string;
        qIndex: number;
        giveUp: true;
        timeMs: number;
      }
): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) {
    socket.emit('error', {
      code: 'MATCH_UNAVAILABLE',
      message: 'Clues questions require Redis-backed realtime state.',
    });
    return;
  }

  const { matchId, qIndex, timeMs } = payload;
  const giveUp = payload.kind === 'giveUp';
  const guess = payload.kind === 'guess' ? payload.guess : '';
  const lockKey = `lock:match:${matchId}:clues_answer`;
  const lock = await acquireLock(lockKey, 2000);
  if (!lock.acquired || !lock.token) {
    socket.emit('error', {
      code: 'MATCH_BUSY',
      message: 'Match is busy. Please retry answer submission.',
    });
    return;
  }

  let committed: {
    question: NonNullable<MatchCache['currentQuestion']>;
    isCorrect: boolean;
    pointsEarned: number;
    answerTimeMs: number;
    clueIndex: number;
    myTotalPoints: number;
    expectedCount: number;
    answerCount: number;
  } | null = null;
  let wrongGuessAck: MatchCluesGuessAckPayload | null = null;

  try {
    const cache = await getMatchCacheOrRebuild(matchId);
    if (!cache || cache.status !== 'active') return;
    if (cache.currentQIndex !== qIndex || !cache.currentQuestion || cache.currentQuestion.qIndex !== qIndex) return;

    const player = getCachedPlayer(cache, socket.data.user.id);
    if (!player) return;
    if (hasUserAnswered(cache, socket.data.user.id)) return;

    const question = cache.currentQuestion;
    if (question.kind !== 'clues' || question.evaluation.kind !== 'clues') {
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'The active question is not a clues round.',
      });
      return;
    }

    const questionDurationMs = getQuestionDurationMs(question.kind, question.evaluation.clues.length);
    const authoritativeTimeMs = toAuthoritativeTimeMsFromCache(
      {
        shownAt: question.shownAt,
        deadlineAt: question.deadlineAt,
      },
      Date.now(),
      timeMs,
      questionDurationMs
    );
    const clueIndex = clueIndexForTimeMs(question.evaluation.clues.length, authoritativeTimeMs, questionDurationMs);
    const isCorrect = !giveUp && fuzzyMatchesAnswer(guess, question.evaluation.acceptedAnswers);
    if (!isCorrect && !giveUp) {
      wrongGuessAck = {
        matchId,
        qIndex,
        clueIndex,
        revealCount: clamp(clueIndex + 2, 1, question.evaluation.clues.length),
      };
      return;
    }
    const pointsEarned = isCorrect ? (CLUES_POINTS_BY_INDEX[clueIndex] ?? 25) : 0;

    cache.answers[socket.data.user.id] = {
      userId: socket.data.user.id,
      questionKind: question.kind,
      selectedIndex: null,
      isCorrect,
      timeMs: authoritativeTimeMs,
      pointsEarned,
      phaseKind: question.phaseKind,
      phaseRound: question.phaseRound,
      shooterSeat: question.shooterSeat,
      answeredAt: new Date().toISOString(),
      clueIndex,
    };

    const expectedCount = getExpectedUserIds(cache).length;
    const currentAnswerCount = answerCount(cache);
    await setMatchCache(cache);

    committed = {
      question,
      isCorrect,
      pointsEarned,
      answerTimeMs: authoritativeTimeMs,
      clueIndex,
      myTotalPoints: player.totalPoints,
      expectedCount,
      answerCount: currentAnswerCount,
    };
  } finally {
    await releaseLock(lockKey, lock.token);
  }

  if (wrongGuessAck) {
    socket.emit('match:clues_guess_ack', wrongGuessAck);
    return;
  }

  if (!committed) return;

  const shouldWaitForOpponent = committed.expectedCount > 1 && committed.answerCount < committed.expectedCount;

  socket.emit('match:answer_ack', {
    matchId,
    qIndex,
    questionKind: committed.question.kind,
    selectedIndex: null,
    isCorrect: committed.isCorrect,
    myTotalPoints: committed.myTotalPoints,
    oppAnswered: !shouldWaitForOpponent,
    pointsEarned: committed.pointsEarned,
    phaseKind: committed.question.phaseKind,
    phaseRound: committed.question.phaseRound,
    shooterSeat: committed.question.shooterSeat,
    clueIndex: committed.clueIndex,
  });

  if (committed.question.phaseKind !== 'penalty') {
    socket.to(`match:${matchId}`).emit('match:opponent_answered', {
      matchId,
      qIndex,
      questionKind: committed.question.kind,
      opponentTotalPoints: committed.myTotalPoints,
      pointsEarned: committed.pointsEarned,
      isCorrect: committed.isCorrect,
      selectedIndex: null,
    });
  }

  if (committed.answerCount >= committed.expectedCount) {
    await resolvePossessionRound(io, matchId, qIndex, false);
  }
}

export async function handlePossessionChanceCardUse(
  _io: QuizballServer,
  socket: QuizballSocket,
  payload: {
    matchId: string;
    qIndex: number;
    clientActionId: string;
  }
): Promise<void> {
  const lockKey = `lock:match:${payload.matchId}:chance_card_use`;
  const lock = await acquireLock(lockKey, 2000);
  if (!lock.acquired || !lock.token) {
    emitChanceCardError(
      socket,
      payload,
      'CHANCE_CARD_SYNC_FAILED',
      '50-50 card is syncing. Please retry.'
    );
    return;
  }

  try {
    const cache = await getMatchCacheOrRebuild(payload.matchId);
    if (!cache || cache.status !== 'active') {
      socket.emit('error', {
        code: 'MATCH_NOT_ACTIVE',
        message: 'No active match found for 50-50 card use.',
        meta: {
          matchId: payload.matchId,
          qIndex: payload.qIndex,
          clientActionId: payload.clientActionId,
        },
      });
      return;
    }

    if (cache.mode !== 'ranked') {
      emitChanceCardError(
        socket,
        payload,
        'CHANCE_CARD_NOT_ALLOWED',
        '50-50 cards are available only in ranked matches.'
      );
      return;
    }

    if (!cache.currentQuestion || cache.currentQuestion.qIndex !== payload.qIndex || cache.currentQIndex !== payload.qIndex) {
      emitChanceCardError(
        socket,
        payload,
        'CHANCE_CARD_NOT_ALLOWED',
        '50-50 card can only be used for the active question.'
      );
      return;
    }

    if (cache.currentQuestion.phaseKind === 'penalty') {
      emitChanceCardError(
        socket,
        payload,
        'CHANCE_CARD_NOT_ALLOWED',
        '50-50 card cannot be used during penalty rounds.'
      );
      return;
    }

    const correctIndex = getCachedMultipleChoiceCorrectIndex(cache.currentQuestion);
    const questionKind = cache.currentQuestion.kind ?? (
      Array.isArray((cache.currentQuestion.questionDTO as { options?: unknown[] } | undefined)?.options)
        ? 'multipleChoice'
        : null
    );
    if (questionKind !== 'multipleChoice' || correctIndex === null) {
      emitChanceCardError(
        socket,
        payload,
        'CHANCE_CARD_NOT_ALLOWED',
        '50-50 card is only available for multiple-choice rounds.'
      );
      return;
    }

    const player = getCachedPlayer(cache, socket.data.user.id);
    if (!player) {
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'Only match participants can use 50-50 cards.',
        meta: {
          matchId: payload.matchId,
          qIndex: payload.qIndex,
          clientActionId: payload.clientActionId,
        },
      });
      return;
    }

    const usageKey = `${payload.qIndex}:${socket.data.user.id}`;
    const existingUse = cache.chanceCardUses[usageKey];
    if (existingUse) {
      socket.emit('match:chance_card_applied', {
        matchId: payload.matchId,
        qIndex: payload.qIndex,
        clientActionId: existingUse.clientActionId,
        eliminatedIndices: existingUse.eliminatedIndices,
        remainingQuantity: existingUse.remainingQuantity,
      });
      return;
    }

    const optionCount = (
      cache.currentQuestion.questionDTO.kind === 'multipleChoice'
      || Array.isArray((cache.currentQuestion.questionDTO as { options?: unknown[] }).options)
    )
      ? ((cache.currentQuestion.questionDTO as { options?: unknown[] }).options?.length ?? 0)
      : 0;
    const wrongIndices = Array.from({ length: optionCount }, (_, index) => index).filter(
      (index) => index !== correctIndex
    );
    if (wrongIndices.length < 2) {
      emitChanceCardError(
        socket,
        payload,
        'CHANCE_CARD_SYNC_FAILED',
        '50-50 card could not be applied to this question.'
      );
      return;
    }
    const shuffledWrongIndices = [...wrongIndices];
    for (let index = shuffledWrongIndices.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [shuffledWrongIndices[index], shuffledWrongIndices[swapIndex]] = [
        shuffledWrongIndices[swapIndex],
        shuffledWrongIndices[index],
      ];
    }
    const eliminatedIndices = shuffledWrongIndices.slice(0, 2);

    let remainingQuantity = 0;
    try {
      const consumed = await storeService.consumeChanceCardForMatch({
        userId: socket.data.user.id,
        matchId: payload.matchId,
        qIndex: payload.qIndex,
        clientActionId: payload.clientActionId,
      });
      remainingQuantity = consumed.remainingQuantity;
    } catch (error) {
      if (error instanceof BadRequestError) {
        emitChanceCardError(
          socket,
          payload,
          'CHANCE_CARD_NOT_AVAILABLE',
          'You do not have any 50-50 cards left.'
        );
        return;
      }

      logger.error({ err: error, payload, userId: socket.data.user.id }, 'Failed to consume 50-50 card');
      emitChanceCardError(
        socket,
        payload,
        'CHANCE_CARD_SYNC_FAILED',
        'Failed to apply 50-50 card.'
      );
      return;
    }

    cache.chanceCardUses[usageKey] = {
      userId: socket.data.user.id,
      qIndex: payload.qIndex,
      clientActionId: payload.clientActionId,
      eliminatedIndices,
      remainingQuantity,
    };
    await setMatchCache(cache);

    socket.emit('match:chance_card_applied', {
      matchId: payload.matchId,
      qIndex: payload.qIndex,
      clientActionId: payload.clientActionId,
      eliminatedIndices,
      remainingQuantity,
    });
  } finally {
    await releaseLock(lockKey, lock.token);
  }
}

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
};
