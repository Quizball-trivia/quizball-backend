import type { QuizballServer, QuizballSocket } from './socket-server.js';
import { logger } from '../core/logger.js';
import { appMetrics } from '../core/metrics.js';
import { withSpan } from '../core/tracing.js';
import { achievementsService } from '../modules/achievements/index.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import { objectivesService } from '../modules/objectives/index.js';
import {
  createInitialPartyQuizState,
  matchesService,
  resolveMatchVariant,
  type PartyQuizStatePayload,
} from '../modules/matches/matches.service.js';
import { questionPayloadSchema } from '../modules/questions/questions.schemas.js';
import { progressionService } from '../modules/progression/progression.service.js';
import { acquireLock, releaseLock } from './locks.js';
import { calculatePoints } from './scoring.js';
import { getRedisClient } from './redis.js';
import { cancelRealtimeTimer, scheduleRealtimeTimer } from './realtime-timer-scheduler.js';
import { createReadyGateRegistry } from './ready-gate.js';
import {
  questionTimerKey,
  matchPresenceKey,
  matchDisconnectKey,
  matchPauseKey,
  matchGraceKey,
  lastMatchKey,
} from './match-keys.js';
import { buildStandings, bumpStateVersion } from './match-utils.js';
import { deleteMatchCache } from './match-cache.js';
import { getMultipleChoiceCorrectIndexFromPayload, normalizeMatchQuestionPayload } from './question-compat.js';
import type { MatchAnswerPayload } from './schemas/match.schemas.js';
import type {
  MatchAnswerAckPayload,
  MatchFinalResultsPayload,
  MatchPartyStatePayload,
  MatchRoundResultPayload,
} from './socket.types.js';
import type { MatchAnswerRow, MatchPlayerRow, MatchRow } from '../modules/matches/matches.types.js';

const PARTY_QUESTION_TIME_MS = 10000;
const PARTY_QUESTION_REVEAL_MS = 3000;
const PARTY_ROUND_READY_ACK_CEILING_MS = 8000;
const PARTY_FINAL_READY_ACK_CEILING_MS = 4000;
const FORFEIT_TTL_SEC = 600;

const pendingReadyGates = createReadyGateRegistry<number>();

function sanitizePartyQuizState(raw: unknown, totalQuestions: number): PartyQuizStatePayload {
  const fallback = createInitialPartyQuizState(totalQuestions);
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }

  const candidate = raw as Partial<PartyQuizStatePayload>;
  return {
    version: 1,
    variant: 'friendly_party_quiz',
    totalQuestions,
    currentQuestion:
      candidate.currentQuestion && typeof candidate.currentQuestion.qIndex === 'number'
        ? {
          qIndex: Math.max(0, candidate.currentQuestion.qIndex),
          ...(typeof candidate.currentQuestion.correctIndex === 'number'
            ? { correctIndex: candidate.currentQuestion.correctIndex }
            : {}),
        }
        : null,
    answeredUserIds: Array.isArray(candidate.answeredUserIds)
      ? candidate.answeredUserIds.filter((userId): userId is string => typeof userId === 'string')
      : [],
    winnerDecisionMethod:
      candidate.winnerDecisionMethod === 'total_points' || candidate.winnerDecisionMethod === 'forfeit'
        ? candidate.winnerDecisionMethod
        : null,
    stateVersionCounter: Math.max(0, Number(candidate.stateVersionCounter ?? 0)),
  };
}

function buildPartyStatePayloadFromRows(
  match: MatchRow,
  state: PartyQuizStatePayload,
  players: MatchPlayerRow[],
  answers: MatchAnswerRow[]
): MatchPartyStatePayload {
  const standings = buildStandings(players);
  const rankByUserId = new Map(standings.map((standing) => [standing.userId, standing.rank]));
  const answeredSet = new Set(answers.map((answer) => answer.user_id));
  const stateVersion = (state.stateVersionCounter * 1000) + answeredSet.size;

  return {
    matchId: match.id,
    totalQuestions: match.total_questions,
    currentQuestionIndex: state.currentQuestion?.qIndex ?? match.current_q_index,
    leaderUserId: standings[0]?.userId ?? null,
    rankingOrder: standings.map((standing) => standing.userId),
    players: players.map((player) => ({
      userId: player.user_id,
      totalPoints: player.total_points,
      correctAnswers: player.correct_answers,
      answered: answeredSet.has(player.user_id),
      rank: rankByUserId.get(player.user_id) ?? standings.length,
      avgTimeMs: player.avg_time_ms,
    })),
    stateVersion,
  };
}

async function buildPartyStatePayload(matchId: string): Promise<MatchPartyStatePayload | null> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match) return null;

  const state = sanitizePartyQuizState(match.state_payload, match.total_questions);
  const players = await matchesRepo.listMatchPlayers(matchId);
  const activeQIndex = state.currentQuestion?.qIndex;
  const answers = typeof activeQIndex === 'number'
    ? await matchesRepo.listAnswersForQuestion(matchId, activeQIndex)
    : [];

  return buildPartyStatePayloadFromRows(match, state, players, answers);
}

export async function emitPartyQuizState(io: QuizballServer, matchId: string): Promise<void> {
  await withSpan('match.party.emit_state', {
    'quizball.match_id': matchId,
  }, async () => {
    const payload = await buildPartyStatePayload(matchId);
    if (!payload) return;
    io.to(`match:${matchId}`).emit('match:party_state', payload);
  });
}

export async function emitPartyQuizStateToSocket(
  socket: QuizballSocket,
  matchId: string
): Promise<void> {
  const payload = await buildPartyStatePayload(matchId);
  if (!payload) return;
  socket.emit('match:party_state', payload);

  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'active') return;
  const state = sanitizePartyQuizState(match.state_payload, match.total_questions);
  const qIndex = state.currentQuestion?.qIndex;
  if (typeof qIndex !== 'number') return;

  const [question, timing, existingAnswer, participants] = await Promise.all([
    matchesService.buildMatchQuestionPayload(matchId, qIndex).then((raw) => normalizeMatchQuestionPayload(raw)),
    matchesRepo.getMatchQuestionTiming(matchId, qIndex),
    matchesRepo.getAnswerForUser(matchId, qIndex, socket.data.user.id),
    matchesRepo.listMatchPlayers(matchId),
  ]);
  if (!question) return;
  const correctIndex = getValidatedPartyQuizCorrectIndex(question);

  // correctIndex is intentionally withheld — clients get it via answer_ack or round_result.
  socket.emit('match:question', {
    matchId,
    qIndex,
    total: match.total_questions,
    question: question.question,
    playableAt: timing?.shown_at ?? undefined,
    deadlineAt: timing?.deadline_at ?? new Date().toISOString(),
    phaseKind: 'normal',
    phaseRound: qIndex + 1,
    shooterSeat: null,
    attackerSeat: null,
  });

  if (!existingAnswer || correctIndex === null) return;

  const player = participants.find((candidate) => candidate.user_id === socket.data.user.id);
  const answeredUsers = await matchesRepo.listAnswersForQuestion(matchId, qIndex);
  const answeredUserIds = new Set(answeredUsers.map((answer) => answer.user_id));
  socket.emit(
    'match:answer_ack',
    buildAnswerAckPayload({
      matchId,
      qIndex,
      selectedIndex: existingAnswer.selected_index,
      isCorrect: existingAnswer.is_correct,
      correctIndex,
      myTotalPoints: player?.total_points ?? existingAnswer.points_earned,
      pointsEarned: existingAnswer.points_earned,
      oppAnswered: answeredUserIds.size >= participants.length,
    })
  );
}

export function cancelPartyQuizQuestionTimer(matchId: string, qIndex: number): void {
  const key = questionTimerKey(matchId, qIndex);
  void cancelRealtimeTimer('party_question', key).catch((error) => {
    logger.warn({ error, matchId, qIndex }, 'Failed to cancel party quiz question timer');
  });
}

export function handlePartyQuizReadyForNextQuestion(
  userId: string,
  matchId: string,
  qIndex: number
): void {
  pendingReadyGates.acknowledge(userId, matchId, qIndex);
}

function schedulePartyQuizTimeout(io: QuizballServer, matchId: string, qIndex: number): void {
  schedulePartyQuizTimeoutAt(io, matchId, qIndex, new Date(Date.now() + PARTY_QUESTION_TIME_MS));
}

function schedulePartyQuizTimeoutAt(
  _io: QuizballServer,
  matchId: string,
  qIndex: number,
  deadlineAt: Date
): void {
  cancelPartyQuizQuestionTimer(matchId, qIndex);
  void scheduleRealtimeTimer('party_question', questionTimerKey(matchId, qIndex), deadlineAt, {
    kind: 'party_question',
    matchId,
    qIndex,
  }).catch((error) => {
    logger.error({ error, matchId, qIndex }, 'Failed to schedule party quiz question timer');
  });
}

function computeResumedDeadlineAt(
  shownAtRaw: string | null,
  deadlineAtRaw: string | null,
  pauseStartedAtMs: number,
  resumedAtMs: number
): Date {
  const shownAtMs = shownAtRaw ? new Date(shownAtRaw).getTime() : Number.NaN;
  const deadlineAtMs = deadlineAtRaw ? new Date(deadlineAtRaw).getTime() : Number.NaN;

  if (!Number.isFinite(shownAtMs) || !Number.isFinite(deadlineAtMs) || deadlineAtMs <= shownAtMs) {
    return new Date(resumedAtMs + PARTY_QUESTION_TIME_MS);
  }

  const effectivePauseStartMs = Math.min(Math.max(pauseStartedAtMs, shownAtMs), deadlineAtMs);
  const remainingMs = Math.max(0, deadlineAtMs - effectivePauseStartMs);
  return new Date(resumedAtMs + remainingMs);
}

function buildAnswerAckPayload(params: {
  matchId: string;
  qIndex: number;
  selectedIndex: number | null;
  isCorrect: boolean;
  correctIndex: number;
  myTotalPoints: number;
  pointsEarned: number;
  oppAnswered?: boolean;
}): MatchAnswerAckPayload {
  return {
    matchId: params.matchId,
    qIndex: params.qIndex,
    questionKind: 'multipleChoice',
    selectedIndex: params.selectedIndex,
    isCorrect: params.isCorrect,
    correctIndex: params.correctIndex,
    myTotalPoints: params.myTotalPoints,
    oppAnswered: params.oppAnswered ?? false,
    pointsEarned: params.pointsEarned,
    phaseKind: 'normal',
    phaseRound: null,
    shooterSeat: null,
  };
}

function getValidatedPartyQuizCorrectIndex(
  payload: Awaited<ReturnType<typeof matchesService.buildMatchQuestionPayload>> | ReturnType<typeof normalizeMatchQuestionPayload>
): number | null {
  if (!payload || payload.question.kind !== 'multipleChoice') {
    return null;
  }

  return getMultipleChoiceCorrectIndexFromPayload(payload);
}

async function buildFinalResultsPayload(matchId: string, resultVersion: number): Promise<MatchFinalResultsPayload | null> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'completed') return null;

  const players = await matchesRepo.listMatchPlayers(matchId);
  const standings = buildStandings(players);
  const payloadPlayers: MatchFinalResultsPayload['players'] = {};
  for (const player of players) {
    payloadPlayers[player.user_id] = {
      totalPoints: player.total_points,
      correctAnswers: player.correct_answers,
      avgTimeMs: player.avg_time_ms,
      goals: player.goals,
      penaltyGoals: player.penalty_goals,
    };
  }

  const startedAtMs = new Date(match.started_at).getTime();
  const endedAtMs = match.ended_at ? new Date(match.ended_at).getTime() : startedAtMs;
  const state = sanitizePartyQuizState(match.state_payload, match.total_questions);
  const unlockedAchievements = await achievementsService.listUnlockedForMatch(matchId);

  return {
    matchId,
    variant: 'friendly_party_quiz',
    winnerId: match.winner_user_id ?? standings[0]?.userId ?? null,
    players: payloadPlayers,
    standings,
    totalQuestions: match.total_questions,
    unlockedAchievements,
    durationMs: Math.max(0, endedAtMs - startedAtMs),
    resultVersion,
    winnerDecisionMethod: state.winnerDecisionMethod,
    totalPointsFallbackUsed: false,
    rankedOutcome: null,
  };
}

async function completePartyQuizMatch(io: QuizballServer, matchId: string): Promise<void> {
  await withSpan('match.party.complete', {
    'quizball.match_id': matchId,
  }, async (span) => {
    const match = await matchesRepo.getMatch(matchId);
    if (!match || match.status !== 'active') return;
    span.setAttribute('quizball.total_questions', match.total_questions);

    const lockKey = `lock:match:${matchId}:complete`;
    const lock = await acquireLock(lockKey, 3000);
    if (!lock.acquired || !lock.token) {
      logger.warn({ matchId }, 'Party quiz completion skipped: lock not acquired');
      return;
    }

    try {
      const activeMatch = await matchesRepo.getMatch(matchId);
      if (!activeMatch || activeMatch.status !== 'active') return;

      const avgTimes = await matchesService.computeAvgTimes(matchId);
      const playersBefore = await matchesRepo.listMatchPlayers(matchId);
      await Promise.all(
        playersBefore.map((player) =>
          matchesRepo.updatePlayerAvgTime(matchId, player.user_id, avgTimes.get(player.user_id) ?? null)
        )
      );

      const players = await matchesRepo.listMatchPlayers(matchId);
      span.setAttribute('quizball.player_count', players.length);
      const standings = buildStandings(players);
      const state = sanitizePartyQuizState(activeMatch.state_payload, activeMatch.total_questions);
      state.currentQuestion = null;
      state.answeredUserIds = [];
      state.winnerDecisionMethod = 'total_points';
      bumpStateVersion(state);

      await matchesRepo.setMatchStatePayload(matchId, state, activeMatch.total_questions);
      await matchesRepo.completeMatch(matchId, standings[0]?.userId ?? null);
      await deleteMatchCache(matchId);

      const resultVersion = Date.now();
      const payload = await buildFinalResultsPayload(matchId, resultVersion);

      const redis = getRedisClient();
      if (redis) {
        await redis.del([
          matchPauseKey(matchId),
          matchGraceKey(matchId),
          ...players.flatMap((player) => [
            matchDisconnectKey(matchId, player.user_id),
            matchPresenceKey(matchId, player.user_id),
          ]),
        ]);
        await Promise.all(
          players.map((player) =>
            redis.set(
              lastMatchKey(player.user_id),
              JSON.stringify({ matchId, resultVersion }),
              { EX: FORFEIT_TTL_SEC }
            )
          )
        );
      }

      if (payload) {
        io.to(`match:${matchId}`).emit('match:final_results', payload);
      }

      void (async () => {
        try {
          await Promise.allSettled([
            achievementsService.evaluateForMatch(
              matchId,
              players.map((player) => player.user_id),
              'friendly_party_quiz'
            ),
            progressionService.awardCompletedMatchXp(matchId),
            objectivesService.evaluateForMatchBestEffort(matchId),
          ]);

          const refreshedPayload = await buildFinalResultsPayload(matchId, resultVersion);
          if (refreshedPayload) {
            io.to(`match:${matchId}`).emit('match:final_results', refreshedPayload);
          }
        } catch (err) {
          logger.warn({ err, matchId }, 'Party quiz post-completion side effects failed');
        }
      })();
    } finally {
      await releaseLock(lockKey, lock.token);
    }
  });
}

function schedulePartyQuizPostRoundAdvance(
  matchId: string,
  resolvedQIndex: number,
  participantUserIds: string[],
  dispatch: () => void,
  ceilingMs = PARTY_ROUND_READY_ACK_CEILING_MS
): void {
  pendingReadyGates.open({
    scopeId: matchId,
    token: resolvedQIndex,
    waitingUserIds: participantUserIds,
    ceilingMs,
    dispatch,
    onTimeout: (missing) => {
      logger.info({ matchId, resolvedQIndex, missing }, 'Party ready-ack ceiling reached — advancing anyway');
    },
  });
}

export async function sendPartyQuizQuestion(
  io: QuizballServer,
  matchId: string,
  qIndex: number
): Promise<{ correctIndex: number } | null> {
  return withSpan('match.party.send_question', {
    'quizball.match_id': matchId,
    'quizball.q_index': qIndex,
  }, async (span) => {
    const startedAt = Date.now();
    const match = await matchesRepo.getMatch(matchId);
    if (!match || match.status !== 'active') return null;
    if (resolveMatchVariant(match.state_payload, match.mode) !== 'friendly_party_quiz') {
      return null;
    }
    if (qIndex >= match.total_questions) {
      await completePartyQuizMatch(io, matchId);
      return null;
    }

    const state = sanitizePartyQuizState(match.state_payload, match.total_questions);
    let payload = normalizeMatchQuestionPayload(await matchesService.buildMatchQuestionPayload(matchId, qIndex));
    let questionSource: 'existing' | 'picked' = 'existing';
    if (!payload) {
      const picked = await matchesRepo.getRandomQuestionForMatch({
        matchId,
        categoryIds: [match.category_a_id],
        difficulties: ['easy', 'medium', 'hard'],
      });
      if (!picked) {
        logger.error({ matchId, qIndex, categoryId: match.category_a_id }, 'Failed to pick party quiz question');
        return null;
      }

      const parsed = questionPayloadSchema.safeParse(picked.payload);
      if (!parsed.success || parsed.data.type !== 'mcq_single') {
        logger.error({ matchId, qIndex, questionId: picked.id }, 'Picked invalid party quiz question payload');
        return null;
      }

      const correctIndex = parsed.data.options.findIndex((option) => option.is_correct === true);
      if (correctIndex < 0) {
        logger.error({ matchId, qIndex, questionId: picked.id }, 'Party quiz question missing a correct answer');
        return null;
      }

      await matchesRepo.insertMatchQuestionIfMissing({
        matchId,
        qIndex,
        questionId: picked.id,
        categoryId: picked.category_id,
        correctIndex,
        phaseKind: 'normal',
        phaseRound: qIndex + 1,
      });

      questionSource = 'picked';
      payload = normalizeMatchQuestionPayload(await matchesService.buildMatchQuestionPayload(matchId, qIndex));
    }

    if (!payload) {
      logger.error({ matchId, qIndex }, 'Unable to build party quiz question payload');
      return null;
    }

    const correctIndex = getValidatedPartyQuizCorrectIndex(payload);
    if (correctIndex === null) {
      logger.error({ matchId, qIndex }, 'Party quiz question payload is invalid after normalization');
      return null;
    }

    const playableAt = new Date(Date.now() + PARTY_QUESTION_REVEAL_MS);
    const deadlineAt = new Date(playableAt.getTime() + PARTY_QUESTION_TIME_MS);

    state.currentQuestion = { qIndex, correctIndex };
    state.answeredUserIds = [];
    bumpStateVersion(state);

    await matchesRepo.setMatchStatePayload(matchId, state, qIndex);
    await matchesRepo.setQuestionTiming(matchId, qIndex, playableAt, deadlineAt);
    await emitPartyQuizState(io, matchId);

    io.to(`match:${matchId}`).emit('match:question', {
      matchId,
      qIndex,
      total: match.total_questions,
      question: payload.question,
      playableAt: playableAt.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
      phaseKind: 'normal',
      phaseRound: qIndex + 1,
      shooterSeat: null,
      attackerSeat: null,
    });

    span.setAttribute('quizball.question_source', questionSource);
    appMetrics.partyQuestionsSent.add(1, { source: questionSource });
    appMetrics.questionGenerationDuration.record(Date.now() - startedAt, {
      mode: 'friendly',
      variant: 'friendly_party_quiz',
      source: questionSource,
    });
    schedulePartyQuizTimeout(io, matchId, qIndex);
    return {
      correctIndex,
    };
  });
}

export async function resumePartyQuizQuestion(
  io: QuizballServer,
  matchId: string,
  qIndex: number,
  pauseStartedAtMs: number
): Promise<boolean> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'active') return false;
  if (resolveMatchVariant(match.state_payload, match.mode) !== 'friendly_party_quiz') {
    return false;
  }

  const question = normalizeMatchQuestionPayload(await matchesService.buildMatchQuestionPayload(matchId, qIndex));
  if (!question) {
    logger.warn({ matchId, qIndex }, 'Unable to resume party quiz question without payload');
    return false;
  }

  if (question.question.kind !== 'multipleChoice') {
    logger.warn({ matchId, qIndex, kind: question.question.kind }, 'Skipping party quiz resume: question is not MCQ');
    return false;
  }
  const correctIndex = getValidatedPartyQuizCorrectIndex(question);
  if (correctIndex === null) {
    logger.warn({ matchId, qIndex }, 'Skipping party quiz resume: question missing correct index');
    return false;
  }

  const timing = await matchesRepo.getMatchQuestionTiming(matchId, qIndex);
  const nowMs = Date.now();
  const playableAt = new Date(nowMs + PARTY_QUESTION_REVEAL_MS);
  const deadlineAt = computeResumedDeadlineAt(
    timing?.shown_at ?? null,
    timing?.deadline_at ?? null,
    pauseStartedAtMs,
    playableAt.getTime()
  );

  await matchesRepo.setQuestionTiming(matchId, qIndex, playableAt, deadlineAt);
  await emitPartyQuizState(io, matchId);

  io.to(`match:${matchId}`).emit('match:question', {
    matchId,
    qIndex,
    total: match.total_questions,
    question: question.question,
    playableAt: playableAt.toISOString(),
    deadlineAt: deadlineAt.toISOString(),
    phaseKind: 'normal',
    phaseRound: qIndex + 1,
    shooterSeat: null,
    attackerSeat: null,
  });

  schedulePartyQuizTimeoutAt(io, matchId, qIndex, deadlineAt);
  return true;
}

export async function ensurePartyQuizActiveTimer(
  io: QuizballServer,
  matchId: string
): Promise<boolean> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'active') return false;
  if (resolveMatchVariant(match.state_payload, match.mode) !== 'friendly_party_quiz') {
    return false;
  }

  const state = sanitizePartyQuizState(match.state_payload, match.total_questions);
  const qIndex = state.currentQuestion?.qIndex;
  if (typeof qIndex !== 'number') return false;

  const timing = await matchesRepo.getMatchQuestionTiming(matchId, qIndex);
  const deadlineAt = timing?.deadline_at ? new Date(timing.deadline_at) : null;
  if (!deadlineAt || Number.isNaN(deadlineAt.getTime())) {
    await resolvePartyQuizRound(io, matchId, qIndex, true);
    return true;
  }

  schedulePartyQuizTimeoutAt(io, matchId, qIndex, deadlineAt);
  return true;
}

export async function resolvePartyQuizRound(
  io: QuizballServer,
  matchId: string,
  qIndex: number,
  fromTimeout = false
): Promise<void> {
  await withSpan('match.party.resolve_round', {
    'quizball.match_id': matchId,
    'quizball.q_index': qIndex,
    'quizball.from_timeout': fromTimeout,
  }, async (span) => {
    const startedAt = Date.now();
    const lockKey = `lock:match:${matchId}:round:${qIndex}`;
    const lock = await acquireLock(lockKey, 3000);
    if (!lock.acquired || !lock.token) {
      logger.warn({ matchId, qIndex }, 'Party quiz round resolve skipped: lock not acquired');
      return;
    }

    try {
      const match = await matchesRepo.getMatch(matchId);
      if (!match || match.status !== 'active') return;
      if (resolveMatchVariant(match.state_payload, match.mode) !== 'friendly_party_quiz') {
        return;
      }

      const state = sanitizePartyQuizState(match.state_payload, match.total_questions);
      if (!state.currentQuestion || state.currentQuestion.qIndex !== qIndex) {
        return;
      }

      const question = await matchesService.buildMatchQuestionPayload(matchId, qIndex);
      if (!question) {
        logger.error({ matchId, qIndex }, 'Party quiz round resolve failed: question payload missing');
        return;
      }
      const correctIndex = getValidatedPartyQuizCorrectIndex(question);
      if (correctIndex === null) {
        logger.error({ matchId, qIndex }, 'Party quiz round resolve failed: question payload is not a valid MCQ');
        return;
      }

      const players = await matchesRepo.listMatchPlayers(matchId);
      const answers = await matchesRepo.listAnswersForQuestion(matchId, qIndex);
      span.setAttribute('quizball.player_count', players.length);
      span.setAttribute('quizball.answer_count', answers.length);
      const answerByUserId = new Map(answers.map((answer) => [answer.user_id, answer]));
      const roundPlayers: MatchRoundResultPayload['players'] = {};

      for (const player of players) {
        const answer = answerByUserId.get(player.user_id);
        roundPlayers[player.user_id] = {
          selectedIndex: answer?.selected_index ?? null,
          isCorrect: answer?.is_correct ?? false,
          timeMs: answer?.time_ms ?? PARTY_QUESTION_TIME_MS,
          pointsEarned: answer?.points_earned ?? 0,
          totalPoints: player.total_points,
          submittedOrderIds: [],
        };
      }

      const standings = buildStandings(players);
      state.currentQuestion = null;
      state.answeredUserIds = [];
      bumpStateVersion(state);

      const nextIndex = qIndex + 1;
      await matchesRepo.setMatchStatePayload(matchId, state, nextIndex);

      io.to(`match:${matchId}`).emit('match:round_result', {
        matchId,
        qIndex,
        questionKind: 'multipleChoice',
        correctIndex,
        reveal: {
          kind: 'multipleChoice',
          correctIndex,
        },
        players: roundPlayers,
        rankingOrder: standings.map((standing) => standing.userId),
        phaseKind: 'normal',
        phaseRound: qIndex + 1,
        shooterSeat: null,
        attackerSeat: null,
      });

      await emitPartyQuizState(io, matchId);
      appMetrics.partyRoundsResolved.add(1, {
        source: fromTimeout ? 'timeout' : 'all_answered',
      });
      appMetrics.roundResolutionDuration.record(Date.now() - startedAt, {
        mode: 'friendly',
        variant: 'friendly_party_quiz',
      });

      const participantUserIds = players.map((player) => player.user_id);
      if (nextIndex >= match.total_questions) {
        schedulePartyQuizPostRoundAdvance(matchId, qIndex, participantUserIds, () => {
          void completePartyQuizMatch(io, matchId).catch((error) => {
            logger.error({ error, matchId }, 'Failed to complete party quiz match');
          });
        }, PARTY_FINAL_READY_ACK_CEILING_MS);
        return;
      }

      schedulePartyQuizPostRoundAdvance(matchId, qIndex, participantUserIds, () => {
        void sendPartyQuizQuestion(io, matchId, nextIndex).catch((error) => {
          logger.error({ error, matchId, nextIndex, fromTimeout }, 'Failed to send next party quiz question');
        });
      });
    } finally {
      cancelPartyQuizQuestionTimer(matchId, qIndex);
      await releaseLock(lockKey, lock.token);
    }
  });
}

export async function handlePartyQuizAnswer(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: MatchAnswerPayload,
  preloadedMatch?: MatchRow
): Promise<void> {
  await withSpan('match.party.answer', {
    'quizball.match_id': payload.matchId,
    'quizball.q_index': payload.qIndex,
    'quizball.user_id': socket.data.user.id,
  }, async (span) => {
    const match = preloadedMatch ?? await matchesRepo.getMatch(payload.matchId);
    if (!match || match.status !== 'active') {
      socket.emit('error', {
        code: 'MATCH_NOT_ACTIVE',
        message: 'Match is no longer active',
      });
      return;
    }

    if (resolveMatchVariant(match.state_payload, match.mode) !== 'friendly_party_quiz') {
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'Party quiz answer submitted for an invalid match variant',
      });
      return;
    }

    const state = sanitizePartyQuizState(match.state_payload, match.total_questions);
    if (!state.currentQuestion || state.currentQuestion.qIndex !== payload.qIndex) {
      socket.emit('error', {
        code: 'MATCH_NOT_ACTIVE',
        message: 'That question is no longer active',
      });
      return;
    }

    const userId = socket.data.user.id;
    const participants = await matchesRepo.listMatchPlayers(payload.matchId);
    const isParticipant = participants.some((player) => player.user_id === userId);
    if (!isParticipant) {
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'You are not a participant in this match',
      });
      return;
    }
    const totalPointsBefore = participants.find((player) => player.user_id === userId)?.total_points ?? 0;

    let correctIndex = state.currentQuestion.correctIndex ?? null;
    if (correctIndex === null) {
      const question = normalizeMatchQuestionPayload(
        await matchesService.buildMatchQuestionPayload(payload.matchId, payload.qIndex)
      );
      if (!question) {
        socket.emit('error', {
          code: 'INVALID_QUESTION',
          message: 'Question data is unavailable',
        });
        return;
      }

      correctIndex = getMultipleChoiceCorrectIndexFromPayload(question);
    }
    if (correctIndex === null) {
      socket.emit('error', {
        code: 'INVALID_QUESTION',
        message: 'Party quiz only supports multiple-choice questions',
      });
      return;
    }

    const isCorrect = payload.selectedIndex === correctIndex;
    span.setAttribute('quizball.answer_correct', isCorrect);
    const pointsEarned = calculatePoints(isCorrect, payload.timeMs, PARTY_QUESTION_TIME_MS);
    const recorded = await matchesRepo.recordPartyQuizAnswerIfMissing({
      matchId: payload.matchId,
      qIndex: payload.qIndex,
      userId,
      selectedIndex: payload.selectedIndex,
      isCorrect,
      timeMs: payload.timeMs,
      pointsEarned,
      phaseKind: 'normal',
      phaseRound: payload.qIndex + 1,
    });

    if (!recorded.answer) {
      logger.error({ matchId: payload.matchId, qIndex: payload.qIndex, userId }, 'Party answer record missing after submit');
      socket.emit('error', {
        code: 'INTERNAL_ERROR',
        message: 'Failed to record answer',
      });
      return;
    }

    if (recorded.inserted) {
      appMetrics.partyAnswersSubmitted.add(1, {
        correct: recorded.answer.is_correct ? 'true' : 'false',
      });
    }

    socket.emit(
      'match:answer_ack',
      buildAnswerAckPayload({
        matchId: payload.matchId,
        qIndex: payload.qIndex,
        selectedIndex: recorded.answer.selected_index,
        isCorrect: recorded.answer.is_correct,
        correctIndex,
        myTotalPoints: recorded.player?.total_points
          ?? totalPointsBefore + (recorded.inserted ? recorded.answer.points_earned : 0),
        pointsEarned: recorded.answer.points_earned,
      })
    );

    const [livePlayers, answers] = await Promise.all([
      matchesRepo.listMatchPlayers(payload.matchId),
      matchesRepo.listAnswersForQuestion(payload.matchId, payload.qIndex),
    ]);
    io.to(`match:${payload.matchId}`).emit(
      'match:party_state',
      buildPartyStatePayloadFromRows(match, state, livePlayers, answers)
    );
    logger.debug({
      matchId: payload.matchId,
      qIndex: payload.qIndex,
      userId,
      answerCount: answers.length,
      participantCount: livePlayers.length,
      inserted: recorded.inserted,
    }, 'Party answer live state emitted');

    if (livePlayers.length > 0 && answers.length >= livePlayers.length) {
      await resolvePartyQuizRound(io, payload.matchId, payload.qIndex);
    }
  });
}
