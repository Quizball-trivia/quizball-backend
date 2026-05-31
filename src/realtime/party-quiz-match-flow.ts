import type { QuizballServer, QuizballSocket } from './socket-server.js';
import { logger } from '../core/logger.js';
import { appMetrics } from '../core/metrics.js';
import { withSpan } from '../core/tracing.js';
import { achievementsService } from '../modules/achievements/index.js';
import { trackMatchCompleted } from '../core/analytics/game-events.js';
import { matchAnswersRepo } from '../modules/matches/match-answers.repo.js';
import { matchPlayersRepo } from '../modules/matches/match-players.repo.js';
import { matchQuestionsRepo } from '../modules/matches/match-questions.repo.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import { objectivesService } from '../modules/objectives/index.js';
import {
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
import {
  getActivePartyPlayers,
  getDroppedUserIds,
  isPartyQuizDropped,
  sanitizePartyQuizState,
} from './party-quiz-state.js';
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

async function isPartyQuizMatchPaused(matchId: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return false;
  return (await redis.exists(matchPauseKey(matchId))) === 1;
}

function buildPartyStatePayloadFromRows(
  match: MatchRow,
  state: PartyQuizStatePayload,
  players: MatchPlayerRow[],
  answers: MatchAnswerRow[]
): MatchPartyStatePayload {
  const droppedUserIds = getDroppedUserIds(state);
  const droppedSet = new Set(droppedUserIds);
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
      status: droppedSet.has(player.user_id) ? 'dropped' : 'active',
    })),
    stateVersion,
  };
}

function partyStateLogFields(payload: MatchPartyStatePayload): Record<string, unknown> {
  return {
    eventName: 'match:party_state',
    matchId: payload.matchId,
    currentQuestionIndex: payload.currentQuestionIndex,
    totalQuestions: payload.totalQuestions,
    stateVersion: payload.stateVersion,
    playerCount: payload.players.length,
    activePlayerCount: payload.players.filter((player) => player.status === 'active').length,
    droppedUserIds: payload.players
      .filter((player) => player.status === 'dropped')
      .map((player) => player.userId),
    answeredUserIds: payload.players
      .filter((player) => player.answered)
      .map((player) => player.userId),
    rankingOrder: payload.rankingOrder,
    leaderUserId: payload.leaderUserId,
  };
}

async function buildPartyStatePayload(matchId: string): Promise<MatchPartyStatePayload | null> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match) return null;

  const state = sanitizePartyQuizState(match.state_payload, match.total_questions);
  const players = await matchPlayersRepo.listMatchPlayers(matchId);
  const activeQIndex = state.currentQuestion?.qIndex;
  const answers = typeof activeQIndex === 'number'
    ? await matchAnswersRepo.listAnswersForQuestion(matchId, activeQIndex)
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
    logger.info(partyStateLogFields(payload), 'Party quiz state emitted');
  });
}

export async function emitPartyQuizStateToSocket(
  socket: QuizballSocket,
  matchId: string
): Promise<void> {
  const payload = await buildPartyStatePayload(matchId);
  if (!payload) return;
  socket.emit('match:party_state', payload);
  logger.info(
    { ...partyStateLogFields(payload), recipientUserId: socket.data.user.id, source: 'socket_hydrate' },
    'Party quiz state emitted to socket'
  );

  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'active') return;
  const state = sanitizePartyQuizState(match.state_payload, match.total_questions);
  const qIndex = state.currentQuestion?.qIndex;
  if (typeof qIndex !== 'number') return;
  if (await isPartyQuizMatchPaused(matchId)) {
    logger.info(
      { eventName: 'match:question', matchId, qIndex, recipientUserId: socket.data.user.id, skipped: true, reason: 'paused' },
      'Party quiz question hydrate skipped while paused'
    );
    return;
  }

  const [question, timing, existingAnswer, participants] = await Promise.all([
    matchesService.buildMatchQuestionPayload(matchId, qIndex).then((raw) => normalizeMatchQuestionPayload(raw)),
    matchQuestionsRepo.getMatchQuestionTiming(matchId, qIndex),
    matchAnswersRepo.getAnswerForUser(matchId, qIndex, socket.data.user.id),
    matchPlayersRepo.listMatchPlayers(matchId),
  ]);
  if (!question) return;
  const correctIndex = getValidatedPartyQuizCorrectIndex(question);

  socket.emit('match:question', {
    matchId,
    qIndex,
    total: match.total_questions,
    question: question.question,
    playableAt: timing?.shown_at ?? undefined,
    deadlineAt: timing?.deadline_at ?? new Date().toISOString(),
    correctIndex: correctIndex ?? undefined,
    phaseKind: 'normal',
    phaseRound: qIndex + 1,
    shooterSeat: null,
    attackerSeat: null,
  });
  logger.info(
    {
      eventName: 'match:question',
      matchId,
      qIndex,
      total: match.total_questions,
      recipientUserId: socket.data.user.id,
      source: 'socket_hydrate',
      playableAt: timing?.shown_at ?? null,
      deadlineAt: timing?.deadline_at ?? null,
      questionKind: question.question.kind,
      hasExistingAnswer: Boolean(existingAnswer),
    },
    'Party quiz question emitted to socket'
  );

  if (!existingAnswer || correctIndex === null) return;

  const player = participants.find((candidate) => candidate.user_id === socket.data.user.id);
  const answeredUsers = await matchAnswersRepo.listAnswersForQuestion(matchId, qIndex);
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
  logger.info(
    {
      eventName: 'match:answer_ack',
      matchId,
      qIndex,
      userId: socket.data.user.id,
      source: 'socket_hydrate',
      selectedIndex: existingAnswer.selected_index,
      isCorrect: existingAnswer.is_correct,
      pointsEarned: existingAnswer.points_earned,
      answeredCount: answeredUserIds.size,
      participantCount: participants.length,
    },
    'Party quiz existing answer ack emitted to socket'
  );
}

export function cancelPartyQuizQuestionTimer(matchId: string, qIndex: number): void {
  const key = questionTimerKey(matchId, qIndex);
  logger.debug({ eventName: 'party_question_timer_cancel', matchId, qIndex, key }, 'Party quiz question timer cancel requested');
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
  logger.info(
    { eventName: 'match:ready_for_next_question', matchId, qIndex, userId },
    'Party quiz ready ack received'
  );
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
  logger.info(
    {
      eventName: 'party_question_timer_scheduled',
      matchId,
      qIndex,
      deadlineAt: deadlineAt.toISOString(),
    },
    'Party quiz question timer scheduled'
  );
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

  const players = await matchPlayersRepo.listMatchPlayers(matchId);
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
    if (await isPartyQuizMatchPaused(matchId)) {
      logger.info(
        { eventName: 'party_match_completion_skipped', matchId, reason: 'paused' },
        'Party quiz completion skipped while match is paused'
      );
      return;
    }

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
      const playersBefore = await matchPlayersRepo.listMatchPlayers(matchId);
      await Promise.all(
        playersBefore.map((player) =>
          matchPlayersRepo.updatePlayerAvgTime(matchId, player.user_id, avgTimes.get(player.user_id) ?? null)
        )
      );

      const players = await matchPlayersRepo.listMatchPlayers(matchId);
      span.setAttribute('quizball.player_count', players.length);
      const standings = buildStandings(players);
      const state = sanitizePartyQuizState(activeMatch.state_payload, activeMatch.total_questions);
      state.currentQuestion = null;
      state.answeredUserIds = [];
      state.winnerDecisionMethod = 'total_points';
      bumpStateVersion(state);

      await matchesRepo.setMatchStatePayload(matchId, state, activeMatch.total_questions);
      await matchesService.completeMatch(matchId, standings[0]?.userId ?? null);
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
        logger.info(
          {
            eventName: 'match:final_results',
            matchId,
            resultVersion,
            winnerId: payload.winnerId,
            winnerDecisionMethod: payload.winnerDecisionMethod,
            playerCount: players.length,
            standings: standings.map((standing) => ({
              userId: standing.userId,
              rank: standing.rank,
              totalPoints: standing.totalPoints,
            })),
          },
          'Party quiz final results emitted'
        );
      }

      // Analytics: per-player match_completed event for party-quiz mode.
      // Mirrors the possession-mode call in `possession-completion.ts`. Goals/penalty
      // counters are always 0 here because party-quiz is score-only.
      try {
        const winnerUserId = standings[0]?.userId ?? null;
        const matchStartedAt = activeMatch.started_at ? new Date(activeMatch.started_at).getTime() : null;
        const durationMs = matchStartedAt ? Math.max(0, Date.now() - matchStartedAt) : 0;
        for (const player of players) {
          const opponent = players.find((p) => p.user_id !== player.user_id) ?? null;
          trackMatchCompleted({
            userId: player.user_id,
            matchId,
            mode: activeMatch.mode,
            won: winnerUserId === player.user_id,
            score: player.total_points,
            opponentScore: opponent?.total_points ?? 0,
            durationMs,
            goalsFor: 0,
            goalsAgainst: 0,
            penaltyGoalsFor: 0,
            penaltyGoalsAgainst: 0,
            winnerDecisionMethod: state.winnerDecisionMethod ?? 'total_points',
            totalQuestions: activeMatch.total_questions,
            correctAnswers: player.correct_answers,
            opponentIsAi: false,
          });
        }
      } catch (err) {
        logger.warn({ err, matchId }, 'Party quiz match_completed analytics failed');
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
      logger.info(
        {
          eventName: 'party_ready_ack_ceiling',
          matchId,
          resolvedQIndex,
          missing,
          ceilingMs,
        },
        'Party ready-ack ceiling reached; advancing'
      );
    },
  });
  logger.info(
    {
      eventName: 'party_ready_gate_opened',
      matchId,
      resolvedQIndex,
      waitingUserIds: participantUserIds,
      ceilingMs,
    },
    'Party quiz post-round ready gate opened'
  );
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
    if (await isPartyQuizMatchPaused(matchId)) {
      logger.info(
        { eventName: 'match:question', matchId, qIndex, skipped: true, reason: 'paused', source: 'dispatch' },
        'Party quiz question dispatch skipped while match is paused'
      );
      return null;
    }
    if (qIndex >= match.total_questions) {
      logger.info(
        { eventName: 'party_match_completion_requested', matchId, qIndex, totalQuestions: match.total_questions },
        'Party quiz question dispatch reached end of match'
      );
      await completePartyQuizMatch(io, matchId);
      return null;
    }

    const state = sanitizePartyQuizState(match.state_payload, match.total_questions);
    let payload = normalizeMatchQuestionPayload(await matchesService.buildMatchQuestionPayload(matchId, qIndex));
    let questionSource: 'existing' | 'picked' = 'existing';
    if (!payload) {
      const picked = await matchQuestionsRepo.getRandomQuestionForMatch({
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

      await matchQuestionsRepo.insertMatchQuestionIfMissing({
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
    await matchQuestionsRepo.setQuestionTiming(matchId, qIndex, playableAt, deadlineAt);
    await emitPartyQuizState(io, matchId);

    io.to(`match:${matchId}`).emit('match:question', {
      matchId,
      qIndex,
      total: match.total_questions,
      question: payload.question,
      playableAt: playableAt.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
      correctIndex,
      phaseKind: 'normal',
      phaseRound: qIndex + 1,
      shooterSeat: null,
      attackerSeat: null,
    });
    logger.info(
      {
        eventName: 'match:question',
        matchId,
        qIndex,
        total: match.total_questions,
        source: questionSource,
        questionKind: payload.question.kind,
        playableAt: playableAt.toISOString(),
        deadlineAt: deadlineAt.toISOString(),
        stateVersion: state.stateVersionCounter,
        durationMs: Date.now() - startedAt,
      },
      'Party quiz question emitted'
    );

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
  if (!match || match.status !== 'active') {
    logger.info(
      { eventName: 'party_question_resume_skipped', matchId, qIndex, reason: 'match_not_active', status: match?.status },
      'Party quiz question resume skipped'
    );
    return false;
  }
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

  const timing = await matchQuestionsRepo.getMatchQuestionTiming(matchId, qIndex);
  const nowMs = Date.now();
  const playableAt = new Date(nowMs + PARTY_QUESTION_REVEAL_MS);
  const deadlineAt = computeResumedDeadlineAt(
    timing?.shown_at ?? null,
    timing?.deadline_at ?? null,
    pauseStartedAtMs,
    playableAt.getTime()
  );

  await matchQuestionsRepo.setQuestionTiming(matchId, qIndex, playableAt, deadlineAt);
  await emitPartyQuizState(io, matchId);

  io.to(`match:${matchId}`).emit('match:question', {
    matchId,
    qIndex,
    total: match.total_questions,
    question: question.question,
    playableAt: playableAt.toISOString(),
    deadlineAt: deadlineAt.toISOString(),
    correctIndex,
    phaseKind: 'normal',
    phaseRound: qIndex + 1,
    shooterSeat: null,
    attackerSeat: null,
  });
  logger.info(
    {
      eventName: 'match:question',
      matchId,
      qIndex,
      total: match.total_questions,
      source: 'resume',
      questionKind: question.question.kind,
      playableAt: playableAt.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
      previousShownAt: timing?.shown_at ?? null,
      previousDeadlineAt: timing?.deadline_at ?? null,
      pauseStartedAt: Number.isFinite(pauseStartedAtMs) ? new Date(pauseStartedAtMs).toISOString() : null,
    },
    'Party quiz question resumed and emitted'
  );

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
  if (await isPartyQuizMatchPaused(matchId)) {
    logger.info(
      { eventName: 'party_question_timer_restore', matchId, skipped: true, reason: 'paused' },
      'Party quiz active timer restore skipped while match is paused'
    );
    return true;
  }

  const state = sanitizePartyQuizState(match.state_payload, match.total_questions);
  const qIndex = state.currentQuestion?.qIndex;
  if (typeof qIndex !== 'number') return false;

  const timing = await matchQuestionsRepo.getMatchQuestionTiming(matchId, qIndex);
  const deadlineAt = timing?.deadline_at ? new Date(timing.deadline_at) : null;
  if (!deadlineAt || Number.isNaN(deadlineAt.getTime())) {
    logger.info(
      { eventName: 'party_question_timer_restore', matchId, qIndex, skipped: true, reason: 'missing_deadline' },
      'Party quiz active timer restore resolving round because deadline is missing'
    );
    await resolvePartyQuizRound(io, matchId, qIndex, true);
    return true;
  }

  schedulePartyQuizTimeoutAt(io, matchId, qIndex, deadlineAt);
  logger.info(
    {
      eventName: 'party_question_timer_restore',
      matchId,
      qIndex,
      deadlineAt: deadlineAt.toISOString(),
    },
    'Party quiz active timer restored'
  );
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
      if (await isPartyQuizMatchPaused(matchId)) {
        logger.info(
          {
            eventName: 'party_round_resolve_skipped',
            matchId,
            qIndex,
            fromTimeout,
            reason: 'paused',
          },
          'Party quiz round resolve skipped while match is paused'
        );
        return;
      }

      const state = sanitizePartyQuizState(match.state_payload, match.total_questions);
      if (!state.currentQuestion || state.currentQuestion.qIndex !== qIndex) {
        logger.info(
          {
            eventName: 'party_round_resolve_skipped',
            matchId,
            qIndex,
            fromTimeout,
            reason: 'stale_question',
            currentQuestionIndex: state.currentQuestion?.qIndex ?? null,
          },
          'Party quiz round resolve skipped for stale question'
        );
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

      const players = await matchPlayersRepo.listMatchPlayers(matchId);
      const activePlayers = getActivePartyPlayers(players, state.droppedUserIds);
      const answers = await matchAnswersRepo.listAnswersForQuestion(matchId, qIndex);
      span.setAttribute('quizball.player_count', players.length);
      span.setAttribute('quizball.active_player_count', activePlayers.length);
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
      const activeAnswerCount = answers.filter((answer) =>
        activePlayers.some((player) => player.user_id === answer.user_id)
      ).length;
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
      logger.info(
        {
          eventName: 'match:round_result',
          matchId,
          qIndex,
          source: fromTimeout ? 'timeout' : 'all_answered',
          answerCount: answers.length,
          activeAnswerCount,
          playerCount: players.length,
          activePlayerCount: activePlayers.length,
          droppedUserIds: state.droppedUserIds,
          nextQIndex: nextIndex,
          totalQuestions: match.total_questions,
          rankingOrder: standings.map((standing) => standing.userId),
          durationMs: Date.now() - startedAt,
        },
        'Party quiz round result emitted'
      );

      await emitPartyQuizState(io, matchId);
      appMetrics.partyRoundsResolved.add(1, {
        source: fromTimeout ? 'timeout' : 'all_answered',
      });
      appMetrics.roundResolutionDuration.record(Date.now() - startedAt, {
        mode: 'friendly',
        variant: 'friendly_party_quiz',
      });

      const participantUserIds = activePlayers.map((player) => player.user_id);
      if (nextIndex >= match.total_questions) {
        logger.info(
          {
            eventName: 'party_match_completion_scheduled',
            matchId,
            resolvedQIndex: qIndex,
            nextQIndex: nextIndex,
            totalQuestions: match.total_questions,
            participantUserIds,
          },
          'Party quiz completion scheduled after final round'
        );
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
      logger.info(
        {
          eventName: 'party_next_question_scheduled',
          matchId,
          resolvedQIndex: qIndex,
          nextQIndex: nextIndex,
          participantUserIds,
        },
        'Party quiz next question scheduled after round'
      );
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
      logger.info(
        {
          eventName: 'match:answer_rejected',
          matchId: payload.matchId,
          qIndex: payload.qIndex,
          userId: socket.data.user.id,
          reason: 'match_not_active',
          status: match?.status ?? null,
        },
        'Party quiz answer rejected'
      );
      socket.emit('error', {
        code: 'MATCH_NOT_ACTIVE',
        message: 'Match is no longer active',
      });
      return;
    }

    if (resolveMatchVariant(match.state_payload, match.mode) !== 'friendly_party_quiz') {
      logger.info(
        {
          eventName: 'match:answer_rejected',
          matchId: payload.matchId,
          qIndex: payload.qIndex,
          userId: socket.data.user.id,
          reason: 'invalid_variant',
        },
        'Party quiz answer rejected'
      );
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'Party quiz answer submitted for an invalid match variant',
      });
      return;
    }

    const state = sanitizePartyQuizState(match.state_payload, match.total_questions);
    const redis = getRedisClient();
    if (redis && await redis.exists(matchPauseKey(payload.matchId))) {
      logger.info(
        {
          eventName: 'match:answer_rejected',
          matchId: payload.matchId,
          qIndex: payload.qIndex,
          userId: socket.data.user.id,
          reason: 'paused',
        },
        'Party quiz answer rejected'
      );
      socket.emit('error', {
        code: 'MATCH_PAUSED',
        message: 'Match is paused while a player reconnects',
      });
      return;
    }
    if (!state.currentQuestion || state.currentQuestion.qIndex !== payload.qIndex) {
      logger.info(
        {
          eventName: 'match:answer_rejected',
          matchId: payload.matchId,
          qIndex: payload.qIndex,
          userId: socket.data.user.id,
          reason: 'stale_question',
          currentQuestionIndex: state.currentQuestion?.qIndex ?? null,
        },
        'Party quiz answer rejected'
      );
      socket.emit('error', {
        code: 'MATCH_NOT_ACTIVE',
        message: 'That question is no longer active',
      });
      return;
    }

    const userId = socket.data.user.id;
    const participants = await matchPlayersRepo.listMatchPlayers(payload.matchId);
    const isParticipant = participants.some((player) => player.user_id === userId);
    if (!isParticipant) {
      logger.info(
        {
          eventName: 'match:answer_rejected',
          matchId: payload.matchId,
          qIndex: payload.qIndex,
          userId,
          reason: 'not_participant',
        },
        'Party quiz answer rejected'
      );
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'You are not a participant in this match',
      });
      return;
    }
    if (isPartyQuizDropped(state, userId)) {
      logger.info(
        {
          eventName: 'match:answer_rejected',
          matchId: payload.matchId,
          qIndex: payload.qIndex,
          userId,
          reason: 'dropped',
          droppedUserIds: state.droppedUserIds,
        },
        'Party quiz answer rejected'
      );
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'You are no longer active in this party quiz',
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
        logger.warn(
          {
            eventName: 'match:answer_rejected',
            matchId: payload.matchId,
            qIndex: payload.qIndex,
            userId,
            reason: 'missing_question_payload',
          },
          'Party quiz answer rejected'
        );
        socket.emit('error', {
          code: 'INVALID_QUESTION',
          message: 'Question data is unavailable',
        });
        return;
      }

      correctIndex = getMultipleChoiceCorrectIndexFromPayload(question);
    }
    if (correctIndex === null) {
      logger.warn(
        {
          eventName: 'match:answer_rejected',
          matchId: payload.matchId,
          qIndex: payload.qIndex,
          userId,
          reason: 'invalid_question_payload',
        },
        'Party quiz answer rejected'
      );
      socket.emit('error', {
        code: 'INVALID_QUESTION',
        message: 'Party quiz only supports multiple-choice questions',
      });
      return;
    }

    const isCorrect = payload.selectedIndex === correctIndex;
    span.setAttribute('quizball.answer_correct', isCorrect);
    const pointsEarned = calculatePoints(isCorrect, payload.timeMs, PARTY_QUESTION_TIME_MS);
    const recorded = await matchesService.recordPartyQuizAnswerIfMissing({
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
    logger.info(
      {
        eventName: 'match:answer_ack',
        matchId: payload.matchId,
        qIndex: payload.qIndex,
        userId,
        selectedIndex: recorded.answer.selected_index,
        isCorrect: recorded.answer.is_correct,
        timeMs: recorded.answer.time_ms,
        pointsEarned: recorded.answer.points_earned,
        inserted: recorded.inserted,
        myTotalPoints: recorded.player?.total_points
          ?? totalPointsBefore + (recorded.inserted ? recorded.answer.points_earned : 0),
      },
      'Party quiz answer ack emitted'
    );

    const [livePlayers, answers] = await Promise.all([
      matchPlayersRepo.listMatchPlayers(payload.matchId),
      matchAnswersRepo.listAnswersForQuestion(payload.matchId, payload.qIndex),
    ]);
    const activePlayers = getActivePartyPlayers(livePlayers, state.droppedUserIds);
    const activeAnswerCount = answers.filter((answer) =>
      activePlayers.some((player) => player.user_id === answer.user_id)
    ).length;
    io.to(`match:${payload.matchId}`).emit(
      'match:party_state',
      buildPartyStatePayloadFromRows(match, state, livePlayers, answers)
    );
    logger.info({
      eventName: 'match:party_state',
      matchId: payload.matchId,
      qIndex: payload.qIndex,
      userId,
      answerCount: answers.length,
      participantCount: livePlayers.length,
      activeParticipantCount: activePlayers.length,
      activeAnswerCount,
      droppedUserIds: state.droppedUserIds,
      inserted: recorded.inserted,
    }, 'Party answer live state emitted');

    if (activePlayers.length > 0 && activeAnswerCount >= activePlayers.length) {
      logger.info(
        {
          eventName: 'party_all_active_players_answered',
          matchId: payload.matchId,
          qIndex: payload.qIndex,
          activeAnswerCount,
          activePlayerCount: activePlayers.length,
        },
        'Party quiz all active players answered'
      );
      await resolvePartyQuizRound(io, payload.matchId, payload.qIndex);
    }
  });
}
