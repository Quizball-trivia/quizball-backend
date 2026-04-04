import type { QuizballServer, QuizballSocket } from './socket-server.js';
import { logger } from '../core/logger.js';
import { appMetrics } from '../core/metrics.js';
import { withSpan } from '../core/tracing.js';
import { achievementsService } from '../modules/achievements/index.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import {
  createInitialPartyQuizState,
  matchesService,
  resolveMatchVariant,
  type PartyQuizStatePayload,
} from '../modules/matches/matches.service.js';
import { questionPayloadSchema } from '../modules/questions/questions.schemas.js';
import { acquireLock, releaseLock } from './locks.js';
import { calculatePoints } from './scoring.js';
import { getRedisClient } from './redis.js';
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
import type { MatchAnswerPayload } from './schemas/match.schemas.js';
import type {
  MatchAnswerAckPayload,
  MatchFinalResultsPayload,
  MatchPartyStatePayload,
  MatchRoundResultPayload,
} from './socket.types.js';

const PARTY_QUESTION_TIME_MS = 10000;
const PARTY_ROUND_RESULT_DELAY_MS = 2500;
const FORFEIT_TTL_SEC = 600;

const questionTimers = new Map<string, NodeJS.Timeout>();

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
        ? { qIndex: Math.max(0, candidate.currentQuestion.qIndex) }
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

async function buildPartyStatePayload(matchId: string): Promise<MatchPartyStatePayload | null> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match) return null;

  const state = sanitizePartyQuizState(match.state_payload, match.total_questions);
  const players = await matchesRepo.listMatchPlayers(matchId);
  const standings = buildStandings(players);
  const rankByUserId = new Map(standings.map((standing) => [standing.userId, standing.rank]));
  const answeredSet = new Set(state.answeredUserIds);

  return {
    matchId,
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
    stateVersion: state.stateVersionCounter,
  };
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
}

export function cancelPartyQuizQuestionTimer(matchId: string, qIndex: number): void {
  const key = questionTimerKey(matchId, qIndex);
  const timer = questionTimers.get(key);
  if (!timer) return;
  clearTimeout(timer);
  questionTimers.delete(key);
}

function schedulePartyQuizTimeout(io: QuizballServer, matchId: string, qIndex: number): void {
  cancelPartyQuizQuestionTimer(matchId, qIndex);
  const timer = setTimeout(() => {
    void resolvePartyQuizRound(io, matchId, qIndex, true).catch((error) => {
      logger.error({ error, matchId, qIndex }, 'Failed to resolve party quiz round from timeout');
    });
  }, PARTY_QUESTION_TIME_MS);
  questionTimers.set(questionTimerKey(matchId, qIndex), timer);
}

function buildAnswerAckPayload(params: {
  matchId: string;
  qIndex: number;
  selectedIndex: number | null;
  isCorrect: boolean;
  correctIndex: number;
  myTotalPoints: number;
  pointsEarned: number;
}): MatchAnswerAckPayload {
  return {
    matchId: params.matchId,
    qIndex: params.qIndex,
    selectedIndex: params.selectedIndex,
    isCorrect: params.isCorrect,
    correctIndex: params.correctIndex,
    myTotalPoints: params.myTotalPoints,
    oppAnswered: false,
    pointsEarned: params.pointsEarned,
    phaseKind: 'normal',
    phaseRound: null,
    shooterSeat: null,
  };
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
    winnerId: match.winner_user_id ?? standings[0]?.userId ?? null,
    players: payloadPlayers,
    standings,
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
      for (const player of playersBefore) {
        await matchesRepo.updatePlayerAvgTime(matchId, player.user_id, avgTimes.get(player.user_id) ?? null);
      }

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
      await achievementsService.evaluateForMatch(
        matchId,
        players.map((player) => player.user_id),
        'friendly_party_quiz'
      );

      const resultVersion = Date.now();
      const payload = await buildFinalResultsPayload(matchId, resultVersion);
      if (payload) {
        io.to(`match:${matchId}`).emit('match:final_results', payload);
      }

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
    } finally {
      await releaseLock(lockKey, lock.token);
    }
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
    let payload = await matchesService.buildMatchQuestionPayload(matchId, qIndex);
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
      payload = await matchesService.buildMatchQuestionPayload(matchId, qIndex);
    }

    if (!payload) {
      logger.error({ matchId, qIndex }, 'Unable to build party quiz question payload');
      return null;
    }

    const shownAt = new Date();
    const deadlineAt = new Date(Date.now() + PARTY_QUESTION_TIME_MS);

    state.currentQuestion = { qIndex };
    state.answeredUserIds = [];
    bumpStateVersion(state);

    await matchesRepo.setMatchStatePayload(matchId, state, qIndex);
    await matchesRepo.setQuestionTiming(matchId, qIndex, shownAt, deadlineAt);
    await emitPartyQuizState(io, matchId);

    io.to(`match:${matchId}`).emit('match:question', {
      matchId,
      qIndex,
      total: match.total_questions,
      question: payload.question,
      deadlineAt: deadlineAt.toISOString(),
      correctIndex: payload.correctIndex,
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
    return { correctIndex: payload.correctIndex };
  });
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
        correctIndex: question.correctIndex,
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

      if (nextIndex >= match.total_questions) {
        setTimeout(() => {
          void completePartyQuizMatch(io, matchId).catch((error) => {
            logger.error({ error, matchId }, 'Failed to complete party quiz match');
          });
        }, PARTY_ROUND_RESULT_DELAY_MS);
        return;
      }

      setTimeout(() => {
        void sendPartyQuizQuestion(io, matchId, nextIndex).catch((error) => {
          logger.error({ error, matchId, nextIndex, fromTimeout }, 'Failed to send next party quiz question');
        });
      }, PARTY_ROUND_RESULT_DELAY_MS);
    } finally {
      cancelPartyQuizQuestionTimer(matchId, qIndex);
      await releaseLock(lockKey, lock.token);
    }
  });
}

export async function handlePartyQuizAnswer(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: MatchAnswerPayload
): Promise<void> {
  await withSpan('match.party.answer', {
    'quizball.match_id': payload.matchId,
    'quizball.q_index': payload.qIndex,
    'quizball.user_id': socket.data.user.id,
  }, async (span) => {
    const match = await matchesRepo.getMatch(payload.matchId);
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

    const existing = await matchesRepo.getAnswerForUser(payload.matchId, payload.qIndex, userId);
    if (existing) {
      socket.emit('error', {
        code: 'ALREADY_ANSWERED',
        message: 'You already answered this question',
      });
      return;
    }

    const question = await matchesService.buildMatchQuestionPayload(payload.matchId, payload.qIndex);
    if (!question) {
      socket.emit('error', {
        code: 'INVALID_QUESTION',
        message: 'Question data is unavailable',
      });
      return;
    }

    const isCorrect = payload.selectedIndex === question.correctIndex;
    span.setAttribute('quizball.answer_correct', isCorrect);
    const pointsEarned = calculatePoints(isCorrect, payload.timeMs, PARTY_QUESTION_TIME_MS);
    const inserted = await matchesRepo.insertMatchAnswerIfMissing({
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

    if (!inserted) {
      socket.emit('error', {
        code: 'ALREADY_ANSWERED',
        message: 'You already answered this question',
      });
      return;
    }

    appMetrics.partyAnswersSubmitted.add(1, {
      correct: isCorrect ? 'true' : 'false',
    });

    const answerLockKey = `lock:match:${payload.matchId}:party_answer:${payload.qIndex}`;
    const answerLock = await acquireLock(answerLockKey, 3000);
    if (!answerLock.acquired || !answerLock.token) {
      socket.emit('error', {
        code: 'TRANSITION_IN_PROGRESS',
        message: 'Answer is being processed. Please retry.',
      });
      return;
    }

    try {
      const latestMatch = await matchesRepo.getMatch(payload.matchId);
      if (!latestMatch || latestMatch.status !== 'active') {
        socket.emit('error', {
          code: 'MATCH_NOT_ACTIVE',
          message: 'Match is no longer active',
        });
        return;
      }

      const latestState = sanitizePartyQuizState(latestMatch.state_payload, latestMatch.total_questions);
      const updatedPlayer = await matchesRepo.updatePlayerTotals(payload.matchId, userId, pointsEarned, isCorrect);
      latestState.answeredUserIds = Array.from(new Set([...latestState.answeredUserIds, userId]));
      bumpStateVersion(latestState);
      await matchesRepo.setMatchStatePayload(payload.matchId, latestState, payload.qIndex);

      socket.emit(
        'match:answer_ack',
        buildAnswerAckPayload({
          matchId: payload.matchId,
          qIndex: payload.qIndex,
          selectedIndex: payload.selectedIndex,
          isCorrect,
          correctIndex: question.correctIndex,
          myTotalPoints: updatedPlayer?.total_points ?? totalPointsBefore + pointsEarned,
          pointsEarned,
        })
      );

      await emitPartyQuizState(io, payload.matchId);

      if (latestState.answeredUserIds.length >= participants.length) {
        await resolvePartyQuizRound(io, payload.matchId, payload.qIndex);
      }
    } finally {
      await releaseLock(answerLockKey, answerLock.token);
    }
  });
}
