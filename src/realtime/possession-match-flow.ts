import { trackEvent } from '../core/analytics.js';
import { logger } from '../core/logger.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import { usersRepo } from '../modules/users/users.repo.js';
import {
  createInitialPossessionState,
  matchesService,
  POSSESSION_QUESTIONS_PER_HALF,
  type PossessionStatePayload,
} from '../modules/matches/matches.service.js';
import { questionPayloadSchema } from '../modules/questions/questions.schemas.js';
import { acquireLock, releaseLock } from './locks.js';
import { RANKED_AI_CORRECTNESS, rankedAiMatchKey } from './ai-ranked.constants.js';
import { getRedisClient } from './redis.js';
import type { QuizballServer, QuizballSocket } from './socket-server.js';
import type { MatchPhaseKind, MatchStatePayload, TacticalCard } from './socket.types.js';
import { clamp, calculatePoints } from './scoring.js';

const QUESTION_TIME_MS = 10000;
const FRONTEND_REVEAL_MS = 2000; // Frontend shows question text before unlocking options
const ROUND_RESULT_DELAY_MS = 1800;
const TIMEOUT_RESOLVE_GRACE_MS = 250;
const TIMEOUT_RESOLVE_BUFFER_MS = 50;
const HALFTIME_DURATION_MS = 15000;
const FAST_ANSWER_THRESHOLD_MS = 3000;
const LAST_MATCH_REPLAY_TTL_SEC = 600;

const questionTimers = new Map<string, NodeJS.Timeout>();
const halftimeTimers = new Map<string, NodeJS.Timeout>();
const aiAnswerTimers = new Map<string, NodeJS.Timeout>();
const aiUserIdByMatch = new Map<string, string | null>();

type Seat = 1 | 2;
type PossessionTactic = 'press-high' | 'play-safe' | 'all-in';

type ResolutionDecision = {
  winnerId: string | null;
  method: 'goals' | 'penalty_goals' | 'total_points_fallback';
  totalPointsFallbackUsed: boolean;
};

type TacticModifiers = {
  correctVsWrongGain: number;
  wrongVsCorrectPenalty: number;
  speedBonusMultiplier: number;
  shotMomentumThreshold: number;
};

type ExpectedAnswerInfo = {
  expectedUserIds: string[];
  shooterSeat: Seat | null;
  attackerSeat: Seat | null;
};

function timerKey(matchId: string, qIndex: number): string {
  return `${matchId}:${qIndex}`;
}

function lastMatchKey(userId: string): string {
  return `user:last_match:${userId}`;
}

function getAiAnswerDelayMs(): number {
  return Math.floor(Math.random() * 4200) + 400;
}

function pickIncorrectIndex(correctIndex: number, optionCount: number): number {
  const candidates = Array.from({ length: optionCount }, (_, index) => index).filter(
    (index) => index !== correctIndex
  );
  const picked = candidates[Math.floor(Math.random() * candidates.length)];
  return picked ?? correctIndex;
}

function asSeat(value: number | null | undefined): Seat | null {
  if (value === 1 || value === 2) return value;
  return null;
}

function nextSeat(seat: Seat): Seat {
  return seat === 1 ? 2 : 1;
}

function getSeatFromUserId(players: Array<{ user_id: string; seat: number }>, userId: string): Seat | null {
  const seat = players.find((player) => player.user_id === userId)?.seat;
  return asSeat(seat);
}

function getUserIdBySeat(players: Array<{ user_id: string; seat: number }>, seat: Seat): string | null {
  return players.find((player) => player.seat === seat)?.user_id ?? null;
}

function parsePossessionState(raw: unknown): PossessionStatePayload {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return createInitialPossessionState(); }
  }
  if (!raw || typeof raw !== 'object') {
    return createInitialPossessionState();
  }

  const candidate = raw as Partial<PossessionStatePayload>;
  const fallback = createInitialPossessionState();

  if (!candidate.phase || !candidate.half || !candidate.seatMomentum || !candidate.goals || !candidate.penaltyGoals) {
    return fallback;
  }

  return {
    ...fallback,
    ...candidate,
    seatMomentum: {
      seat1: clamp(Number(candidate.seatMomentum.seat1 ?? fallback.seatMomentum.seat1), 0, 6),
      seat2: clamp(Number(candidate.seatMomentum.seat2 ?? fallback.seatMomentum.seat2), 0, 6),
    },
    goals: {
      seat1: Math.max(0, Number(candidate.goals.seat1 ?? fallback.goals.seat1)),
      seat2: Math.max(0, Number(candidate.goals.seat2 ?? fallback.goals.seat2)),
    },
    penaltyGoals: {
      seat1: Math.max(0, Number(candidate.penaltyGoals.seat1 ?? fallback.penaltyGoals.seat1)),
      seat2: Math.max(0, Number(candidate.penaltyGoals.seat2 ?? fallback.penaltyGoals.seat2)),
    },
    sharedPossession: clamp(Number(candidate.sharedPossession ?? fallback.sharedPossession), 0, 100),
    kickOffSeat: asSeat(candidate.kickOffSeat) ?? fallback.kickOffSeat,
    normalQuestionsPerHalf: POSSESSION_QUESTIONS_PER_HALF,
    normalQuestionsAnsweredInHalf: Math.max(0, Number(candidate.normalQuestionsAnsweredInHalf ?? 0)),
    normalQuestionsAnsweredTotal: Math.max(0, Number(candidate.normalQuestionsAnsweredTotal ?? 0)),
    halftime: {
      deadlineAt: candidate.halftime?.deadlineAt ?? null,
      tactics: {
        seat1: (candidate.halftime?.tactics?.seat1 as PossessionTactic | null) ?? null,
        seat2: (candidate.halftime?.tactics?.seat2 as PossessionTactic | null) ?? null,
      },
    },
    shot: {
      attackerSeat: asSeat(candidate.shot?.attackerSeat),
    },
    penalty: {
      round: Math.max(0, Number(candidate.penalty?.round ?? 0)),
      shooterSeat: asSeat(candidate.penalty?.shooterSeat) ?? 1,
      suddenDeath: Boolean(candidate.penalty?.suddenDeath),
      kicksTaken: {
        seat1: Math.max(0, Number(candidate.penalty?.kicksTaken?.seat1 ?? 0)),
        seat2: Math.max(0, Number(candidate.penalty?.kicksTaken?.seat2 ?? 0)),
      },
    },
    currentQuestion: candidate.currentQuestion
      ? {
        qIndex: Number(candidate.currentQuestion.qIndex ?? 0),
        phaseKind: (candidate.currentQuestion.phaseKind as MatchPhaseKind) ?? 'normal',
        phaseRound: Number(candidate.currentQuestion.phaseRound ?? 0),
        shooterSeat: asSeat(candidate.currentQuestion.shooterSeat),
        attackerSeat: asSeat(candidate.currentQuestion.attackerSeat),
      }
      : null,
    winnerDecisionMethod:
      (candidate.winnerDecisionMethod as PossessionStatePayload['winnerDecisionMethod']) ?? null,
  };
}

function phaseKindFromState(state: PossessionStatePayload): MatchPhaseKind {
  if (state.phase === 'SHOT_ON_GOAL') return 'shot';
  if (state.phase === 'PENALTY_SHOOTOUT') return 'penalty';
  return 'normal';
}

function getDifficultyForState(state: PossessionStatePayload): Array<'easy' | 'medium' | 'hard'> {
  const phaseKind = phaseKindFromState(state);
  if (phaseKind === 'shot' || phaseKind === 'penalty') return ['hard'];

  const p = state.sharedPossession;
  if (p <= 20) return ['easy'];
  if (p <= 45) return ['easy', 'medium'];
  if (p <= 70) return ['medium'];
  return ['medium', 'hard'];
}

function speedBonusFromTimeMs(timeMs: number): number {
  const clampedMs = clamp(timeMs, 0, QUESTION_TIME_MS);
  const remainingMs = Math.max(0, QUESTION_TIME_MS - clampedMs);
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const questionPoints = remainingSeconds * 100;
  return clamp(Math.floor(questionPoints / 300), 0, 5);
}

function getTacticForSeat(state: PossessionStatePayload, seat: Seat): PossessionTactic | null {
  if (state.half === 1) return null;
  return (seat === 1 ? state.halftime.tactics.seat1 : state.halftime.tactics.seat2) ?? 'play-safe';
}

function getTacticModifiers(tactic: PossessionTactic | null): TacticModifiers {
  switch (tactic) {
    case 'press-high':
      return {
        correctVsWrongGain: 12,
        wrongVsCorrectPenalty: -12,
        speedBonusMultiplier: 1.25,
        shotMomentumThreshold: 4,
      };
    case 'play-safe':
      return {
        correctVsWrongGain: 9,
        wrongVsCorrectPenalty: -8,
        speedBonusMultiplier: 1,
        shotMomentumThreshold: 4,
      };
    case 'all-in':
      return {
        correctVsWrongGain: 14,
        wrongVsCorrectPenalty: -14,
        speedBonusMultiplier: 1,
        shotMomentumThreshold: 3,
      };
    default:
      return {
        correctVsWrongGain: 12,
        wrongVsCorrectPenalty: -10,
        speedBonusMultiplier: 1,
        shotMomentumThreshold: 4,
      };
  }
}

function toMatchStatePayload(matchId: string, state: PossessionStatePayload): MatchStatePayload {
  const phaseKind = state.currentQuestion?.phaseKind ?? phaseKindFromState(state);
  const phaseRound = state.currentQuestion?.phaseRound ?? 0;
  return {
    matchId,
    engine: 'possession_v1',
    phase: state.phase,
    half: state.half,
    sharedPossession: state.sharedPossession,
    normalQuestionsAnsweredInHalf: state.normalQuestionsAnsweredInHalf,
    seatMomentum: {
      seat1: state.seatMomentum.seat1,
      seat2: state.seatMomentum.seat2,
    },
    attackerSeat: state.shot.attackerSeat,
    kickOffSeat: state.kickOffSeat,
    goals: {
      seat1: state.goals.seat1,
      seat2: state.goals.seat2,
    },
    penaltyGoals: {
      seat1: state.penaltyGoals.seat1,
      seat2: state.penaltyGoals.seat2,
    },
    phaseKind,
    phaseRound,
    shooterSeat: state.currentQuestion?.shooterSeat ?? (state.phase === 'PENALTY_SHOOTOUT' ? state.penalty.shooterSeat : null),
    halftimeReady: {
      seat1: !!state.halftime.tactics.seat1,
      seat2: !!state.halftime.tactics.seat2,
    },
  };
}

async function emitMatchState(io: QuizballServer, matchId: string, state: PossessionStatePayload): Promise<void> {
  io.to(`match:${matchId}`).emit('match:state', toMatchStatePayload(matchId, state));
}

export async function emitPossessionStateToSocket(socket: QuizballSocket, matchId: string): Promise<void> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.engine !== 'possession_v1') return;
  const state = parsePossessionState(match.state_payload);
  socket.emit('match:state', toMatchStatePayload(matchId, state));
}

function clearQuestionTimer(matchId: string, qIndex: number): void {
  const key = timerKey(matchId, qIndex);
  const timer = questionTimers.get(key);
  if (!timer) return;
  clearTimeout(timer);
  questionTimers.delete(key);
}

function clearAiAnswerTimer(matchId: string, qIndex: number): void {
  const key = timerKey(matchId, qIndex);
  const timer = aiAnswerTimers.get(key);
  if (!timer) return;
  clearTimeout(timer);
  aiAnswerTimers.delete(key);
}

function clearHalftimeTimer(matchId: string): void {
  const timer = halftimeTimers.get(matchId);
  if (!timer) return;
  clearTimeout(timer);
  halftimeTimers.delete(matchId);
}

function scheduleQuestionTimeout(io: QuizballServer, matchId: string, qIndex: number): void {
  const key = timerKey(matchId, qIndex);
  const existing = questionTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  const timeout = setTimeout(() => {
    void resolvePossessionRound(io, matchId, qIndex, true).catch((error) => {
      logger.error({ error, matchId, qIndex }, 'Failed to resolve possession round after timeout');
    });
  }, QUESTION_TIME_MS + FRONTEND_REVEAL_MS + TIMEOUT_RESOLVE_GRACE_MS + TIMEOUT_RESOLVE_BUFFER_MS);

  questionTimers.set(key, timeout);
}

function toAuthoritativeTimeMs(
  questionTiming: {
    shown_at: string | null;
    deadline_at: string | null;
  },
  nowMs: number,
  fallbackTimeMs: number
): number {
  if (questionTiming.shown_at) {
    const shownAtMs = new Date(questionTiming.shown_at).getTime();
    if (Number.isFinite(shownAtMs)) {
      return clamp(Math.round(nowMs - shownAtMs), 0, QUESTION_TIME_MS);
    }
  }

  if (questionTiming.deadline_at) {
    const deadlineMs = new Date(questionTiming.deadline_at).getTime();
    if (Number.isFinite(deadlineMs)) {
      return clamp(Math.round(QUESTION_TIME_MS - (deadlineMs - nowMs)), 0, QUESTION_TIME_MS);
    }
  }

  return clamp(Math.round(fallbackTimeMs), 0, QUESTION_TIME_MS);
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

async function resolveAiUserIdForMatch(matchId: string): Promise<string | null> {
  if (aiUserIdByMatch.has(matchId)) {
    return aiUserIdByMatch.get(matchId) ?? null;
  }

  const redis = getRedisClient();
  if (redis) {
    const aiUserId = await redis.get(rankedAiMatchKey(matchId));
    if (aiUserId) {
      aiUserIdByMatch.set(matchId, aiUserId);
      return aiUserId;
    }
  }

  const players = await matchesRepo.listMatchPlayers(matchId);
  for (const player of players) {
    const user = await usersRepo.getById(player.user_id);
    if (user?.is_ai) {
      aiUserIdByMatch.set(matchId, user.id);
      return user.id;
    }
  }

  aiUserIdByMatch.set(matchId, null);
  return null;
}

async function schedulePossessionAiAnswer(
  io: QuizballServer,
  matchId: string,
  qIndex: number,
  options: {
    correctIndex: number;
    optionCount: number;
    phaseKind: MatchPhaseKind;
    phaseRound: number;
    shooterSeat: Seat | null;
  }
): Promise<void> {
  const key = timerKey(matchId, qIndex);
  clearAiAnswerTimer(matchId, qIndex);

  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'active' || match.engine !== 'possession_v1') return;

  const aiUserId = await resolveAiUserIdForMatch(matchId);
  if (!aiUserId) return;

  const players = await matchesRepo.listMatchPlayers(matchId);
  const hasAi = players.some((player) => player.user_id === aiUserId);
  if (!hasAi) return;

  const expected = await getExpectedAnswersForQuestion(matchId, qIndex);
  if (!expected) return;
  if (!expected.expectedUserIds.includes(aiUserId)) return;

  const delayMs = getAiAnswerDelayMs();
  const timeout = setTimeout(() => {
    const stored = aiAnswerTimers.get(key);
    if (stored) {
      clearTimeout(stored);
      aiAnswerTimers.delete(key);
    }

    void (async () => {
      try {
        const freshMatch = await matchesRepo.getMatch(matchId);
        if (
          !freshMatch ||
          freshMatch.status !== 'active' ||
          freshMatch.engine !== 'possession_v1' ||
          freshMatch.current_q_index !== qIndex
        ) {
          return;
        }

        const existing = await matchesRepo.getAnswerForUser(matchId, qIndex, aiUserId);
        if (existing) return;

        const isCorrect = Math.random() < RANKED_AI_CORRECTNESS;
        const selectedIndex = isCorrect
          ? options.correctIndex
          : pickIncorrectIndex(options.correctIndex, options.optionCount);
        const timeMs = clamp(delayMs, 0, QUESTION_TIME_MS);
        const pointsEarned = calculatePoints(isCorrect, timeMs, QUESTION_TIME_MS);

        await matchesRepo.insertMatchAnswer({
          matchId,
          qIndex,
          userId: aiUserId,
          selectedIndex,
          isCorrect,
          timeMs,
          pointsEarned,
          phaseKind: options.phaseKind,
          phaseRound: options.phaseRound,
          shooterSeat: options.shooterSeat,
        });

        const updatedAiPlayer = await matchesRepo.updatePlayerTotals(
          matchId,
          aiUserId,
          pointsEarned,
          isCorrect
        );

        if (options.phaseKind !== 'penalty') {
          io.to(`match:${matchId}`).emit('match:opponent_answered', {
            matchId,
            qIndex,
            opponentTotalPoints: updatedAiPlayer?.total_points ?? 0,
            pointsEarned,
            isCorrect,
          });
        }

        const refreshedExpected = await getExpectedAnswersForQuestion(matchId, qIndex);
        if (!refreshedExpected) return;

        const answers = await matchesRepo.listAnswersForQuestion(matchId, qIndex);
        if (answers.length >= refreshedExpected.expectedUserIds.length) {
          await resolvePossessionRound(io, matchId, qIndex, false);
        }
      } catch (error) {
        logger.warn({ error, matchId, qIndex }, 'Possession AI answer scheduling failed');
      }
    })();
  }, delayMs);

  aiAnswerTimers.set(key, timeout);
}

function determineShotAttackerSeat(state: PossessionStatePayload): Seat | null {
  const seat1Mods = getTacticModifiers(getTacticForSeat(state, 1));
  const seat2Mods = getTacticModifiers(getTacticForSeat(state, 2));

  if (state.sharedPossession >= 75 || state.seatMomentum.seat1 >= seat1Mods.shotMomentumThreshold) {
    return 1;
  }
  if (state.sharedPossession <= 25 || state.seatMomentum.seat2 >= seat2Mods.shotMomentumThreshold) {
    return 2;
  }
  return null;
}

function shotReboundPossession(attackerSeat: Seat): number {
  return attackerSeat === 1 ? 60 : 40;
}

function decideWinner(
  players: Array<{ user_id: string; seat: number; total_points: number }>,
  state: PossessionStatePayload
): ResolutionDecision {
  const seat1UserId = getUserIdBySeat(players, 1);
  const seat2UserId = getUserIdBySeat(players, 2);

  if (state.goals.seat1 > state.goals.seat2) {
    return { winnerId: seat1UserId, method: 'goals', totalPointsFallbackUsed: false };
  }
  if (state.goals.seat2 > state.goals.seat1) {
    return { winnerId: seat2UserId, method: 'goals', totalPointsFallbackUsed: false };
  }

  if (state.penaltyGoals.seat1 > state.penaltyGoals.seat2) {
    return { winnerId: seat1UserId, method: 'penalty_goals', totalPointsFallbackUsed: false };
  }
  if (state.penaltyGoals.seat2 > state.penaltyGoals.seat1) {
    return { winnerId: seat2UserId, method: 'penalty_goals', totalPointsFallbackUsed: false };
  }

  const seat1Points = players.find((player) => player.seat === 1)?.total_points ?? 0;
  const seat2Points = players.find((player) => player.seat === 2)?.total_points ?? 0;

  if (seat1Points > seat2Points) {
    return { winnerId: seat1UserId, method: 'total_points_fallback', totalPointsFallbackUsed: true };
  }
  if (seat2Points > seat1Points) {
    return { winnerId: seat2UserId, method: 'total_points_fallback', totalPointsFallbackUsed: true };
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
  return { winnerId: seat1UserId, method: 'total_points_fallback', totalPointsFallbackUsed: true };
}

async function completePossessionMatch(
  io: QuizballServer,
  matchId: string,
  state: PossessionStatePayload
): Promise<void> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'active') return;

  const players = await matchesRepo.listMatchPlayers(matchId);
  const decision = decideWinner(players, state);

  state.phase = 'COMPLETED';
  state.currentQuestion = null;
  state.winnerDecisionMethod = decision.method;

  await matchesRepo.setMatchStatePayload(matchId, state, match.current_q_index);
  await matchesRepo.completeMatch(matchId, decision.winnerId);

  const avgTimes = await matchesService.computeAvgTimes(matchId);
  for (const player of players) {
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

  const durationMs = Date.now() - new Date(match.started_at).getTime();
  const resultVersion = Date.now();

  io.to(`match:${matchId}`).emit('match:final_results', {
    matchId,
    engine: 'possession_v1',
    winnerId: decision.winnerId,
    players: payloadPlayers,
    durationMs,
    resultVersion,
    winnerDecisionMethod: decision.method,
    totalPointsFallbackUsed: decision.totalPointsFallbackUsed,
  });

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

  aiUserIdByMatch.delete(matchId);
  clearHalftimeTimer(matchId);
}

async function maybePickQuestionForState(matchId: string, state: PossessionStatePayload): Promise<{
  questionId: string;
  categoryId: string;
  correctIndex: number;
} | null> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match) return null;

  const preferredDifficulties = getDifficultyForState(state);
  const categoryIds: [string, string] = [match.category_a_id, match.category_b_id];

  let row = await matchesRepo.getRandomQuestionForMatch({
    matchId,
    categoryIds,
    difficulties: preferredDifficulties,
  });

  if (!row) {
    row = await matchesRepo.getRandomQuestionForMatch({
      matchId,
      categoryIds,
      difficulties: ['easy', 'medium', 'hard'],
    });
  }

  if (!row) return null;

  const parsed = questionPayloadSchema.safeParse(row.payload);
  if (!parsed.success || parsed.data.type !== 'mcq_single') {
    return null;
  }

  const correctIndex = parsed.data.options.findIndex((option) => option.is_correct);
  if (correctIndex < 0) return null;

  return {
    questionId: row.id,
    categoryId: row.category_id,
    correctIndex,
  };
}

async function finalizeHalftime(io: QuizballServer, matchId: string): Promise<void> {
  const lockKey = `lock:match:${matchId}:halftime`;
  const lock = await acquireLock(lockKey, 5000);
  if (!lock.acquired || !lock.token) return;

  try {
    const match = await matchesRepo.getMatch(matchId);
    if (!match || match.status !== 'active' || match.engine !== 'possession_v1') return;

    const state = parsePossessionState(match.state_payload);
    if (state.phase !== 'HALFTIME') return;

    state.halftime.tactics.seat1 = state.halftime.tactics.seat1 ?? 'play-safe';
    state.halftime.tactics.seat2 = state.halftime.tactics.seat2 ?? 'play-safe';
    state.halftime.deadlineAt = null;

    state.half = 2;
    state.phase = 'NORMAL_PLAY';
    state.sharedPossession = 50;
    state.seatMomentum = { seat1: 0, seat2: 0 };
    state.kickOffSeat = nextSeat(state.kickOffSeat);
    state.shot.attackerSeat = null;
    state.currentQuestion = null;
    state.normalQuestionsAnsweredInHalf = 0;

    await matchesRepo.setMatchStatePayload(matchId, state, match.current_q_index);
    await emitMatchState(io, matchId, state);

    await sendPossessionMatchQuestion(io, matchId, match.current_q_index);
  } finally {
    clearHalftimeTimer(matchId);
    await releaseLock(lockKey, lock.token);
  }
}

function scheduleHalftimeTimeout(io: QuizballServer, matchId: string): void {
  clearHalftimeTimer(matchId);
  const timer = setTimeout(() => {
    void finalizeHalftime(io, matchId).catch((error) => {
      logger.error({ error, matchId }, 'Failed to finalize halftime timer');
    });
  }, HALFTIME_DURATION_MS);
  halftimeTimers.set(matchId, timer);
}

export async function handlePossessionTacticSelect(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: { matchId: string; tactic: TacticalCard }
): Promise<void> {
  const lockKey = `lock:match:${payload.matchId}:tactic_select`;
  const lock = await acquireLock(lockKey, 3000);
  if (!lock.acquired || !lock.token) {
    socket.emit('error', {
      code: 'MATCH_BUSY',
      message: 'Match is busy. Please retry tactic selection.',
    });
    return;
  }

  try {
    const match = await matchesRepo.getMatch(payload.matchId);
    if (!match || match.status !== 'active' || match.engine !== 'possession_v1') {
      socket.emit('error', {
        code: 'MATCH_NOT_ACTIVE',
        message: 'No active possession match found.',
      });
      return;
    }

    const state = parsePossessionState(match.state_payload);
    if (state.phase !== 'HALFTIME') {
      socket.emit('error', {
        code: 'MATCH_INVALID_PHASE',
        message: 'Tactics can only be selected during halftime.',
      });
      return;
    }

    const players = await matchesRepo.listMatchPlayers(payload.matchId);
    const seat = getSeatFromUserId(players, socket.data.user.id);
    if (!seat) {
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'You are not a participant in this match.',
      });
      return;
    }

    if (seat === 1) state.halftime.tactics.seat1 = payload.tactic;
    if (seat === 2) state.halftime.tactics.seat2 = payload.tactic;

    await matchesRepo.setMatchStatePayload(payload.matchId, state, match.current_q_index);
    await emitMatchState(io, payload.matchId, state);

    if (state.halftime.tactics.seat1 && state.halftime.tactics.seat2) {
      clearHalftimeTimer(payload.matchId);
      await finalizeHalftime(io, payload.matchId);
    }
  } finally {
    await releaseLock(lockKey, lock.token);
  }
}

export async function sendPossessionMatchQuestion(
  io: QuizballServer,
  matchId: string,
  qIndex: number
): Promise<{ correctIndex: number } | null> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'active' || match.engine !== 'possession_v1') {
    return null;
  }

  const state = parsePossessionState(match.state_payload);

  if (state.phase === 'HALFTIME') {
    scheduleHalftimeTimeout(io, matchId);
    await emitMatchState(io, matchId, state);
    return null;
  }
  if (state.phase === 'COMPLETED') {
    return null;
  }

  const phaseKind = phaseKindFromState(state);
  const attackerSeat = phaseKind === 'shot'
    ? (state.shot.attackerSeat ?? (state.sharedPossession >= 50 ? 1 : 2))
    : null;
  const shooterSeat = phaseKind === 'penalty' ? state.penalty.shooterSeat : null;
  const phaseRound = phaseKind === 'normal'
    ? state.normalQuestionsAnsweredTotal + 1
    : phaseKind === 'shot'
      ? state.goals.seat1 + state.goals.seat2 + 1
      : state.penalty.round + 1;

  const picked = await maybePickQuestionForState(matchId, state);
  if (!picked) {
    logger.error({ matchId, phaseKind }, 'Failed to pick a valid question for possession state');
    return null;
  }

  const inserted = await matchesRepo.insertMatchQuestionIfMissing({
    matchId,
    qIndex,
    questionId: picked.questionId,
    categoryId: picked.categoryId,
    correctIndex: picked.correctIndex,
    phaseKind,
    phaseRound,
    shooterSeat,
    attackerSeat,
  });

  if (!inserted) {
    logger.warn({ matchId, qIndex, phaseKind }, 'Question row already exists for possession qIndex');
  }

  const payload = await matchesService.buildMatchQuestionPayload(matchId, qIndex);
  if (!payload) {
    logger.error({ matchId, qIndex }, 'Unable to build possession match question payload');
    return null;
  }

  const deadlineAt = new Date(Date.now() + QUESTION_TIME_MS);
  await matchesRepo.setQuestionTiming(matchId, qIndex, new Date(), deadlineAt);

  state.currentQuestion = {
    qIndex,
    phaseKind,
    phaseRound,
    shooterSeat,
    attackerSeat,
  };

  await matchesRepo.setMatchStatePayload(matchId, state, qIndex);
  await emitMatchState(io, matchId, state);

  io.to(`match:${matchId}`).emit('match:question', {
    matchId,
    engine: 'possession_v1',
    qIndex,
    total: match.total_questions,
    question: payload.question,
    deadlineAt: deadlineAt.toISOString(),
    phaseKind,
    phaseRound,
    shooterSeat,
    attackerSeat,
  });

  scheduleQuestionTimeout(io, matchId, qIndex);
  void schedulePossessionAiAnswer(io, matchId, qIndex, {
    correctIndex: payload.correctIndex,
    optionCount: payload.question.options.length,
    phaseKind,
    phaseRound,
    shooterSeat,
  }).catch((error) => {
    logger.warn({ error, matchId, qIndex }, 'Failed to schedule possession AI answer');
  });

  return { correctIndex: payload.correctIndex };
}

function applyNormalResolution(
  state: PossessionStatePayload,
  seat1Answer: { isCorrect: boolean; timeMs: number },
  seat2Answer: { isCorrect: boolean; timeMs: number }
): void {
  let sharedPossession = state.sharedPossession;
  let momentum1 = state.seatMomentum.seat1;
  let momentum2 = state.seatMomentum.seat2;

  const seat1Mods = getTacticModifiers(getTacticForSeat(state, 1));
  const seat2Mods = getTacticModifiers(getTacticForSeat(state, 2));

  const seat1Correct = seat1Answer.isCorrect;
  const seat2Correct = seat2Answer.isCorrect;

  if (!seat1Correct && !seat2Correct) {
    if (sharedPossession > 50) sharedPossession -= 2;
    else if (sharedPossession < 50) sharedPossession += 2;
  } else if (seat1Correct !== seat2Correct) {
    const winnerSeat: Seat = seat1Correct ? 1 : 2;
    const loserSeat: Seat = winnerSeat === 1 ? 2 : 1;

    const winnerAnswer = winnerSeat === 1 ? seat1Answer : seat2Answer;
    const winnerMods = winnerSeat === 1 ? seat1Mods : seat2Mods;
    const loserMods = loserSeat === 1 ? seat1Mods : seat2Mods;

    const speedBonus = speedBonusFromTimeMs(winnerAnswer.timeMs);
    const adjustedSpeedBonus = Math.round(speedBonus * winnerMods.speedBonusMultiplier);
    const gain = winnerMods.correctVsWrongGain + adjustedSpeedBonus;
    const penalty = Math.abs(loserMods.wrongVsCorrectPenalty);
    const delta = Math.max(1, Math.round((gain + penalty) / 2));

    if (winnerSeat === 1) {
      sharedPossession += delta;
      momentum1 += 2;
      if (winnerAnswer.timeMs <= FAST_ANSWER_THRESHOLD_MS) momentum1 += 1;
      momentum2 -= 1;
    } else {
      sharedPossession -= delta;
      momentum2 += 2;
      if (winnerAnswer.timeMs <= FAST_ANSWER_THRESHOLD_MS) momentum2 += 1;
      momentum1 -= 1;
    }
  } else {
    let fasterSeat: Seat | null = null;
    if (seat1Answer.timeMs < seat2Answer.timeMs) fasterSeat = 1;
    else if (seat2Answer.timeMs < seat1Answer.timeMs) fasterSeat = 2;

    if (fasterSeat) {
      const fasterMods = fasterSeat === 1 ? seat1Mods : seat2Mods;
      const fasterAnswer = fasterSeat === 1 ? seat1Answer : seat2Answer;
      const speedBonus = speedBonusFromTimeMs(fasterAnswer.timeMs);
      const adjustedSpeedBonus = Math.round(speedBonus * fasterMods.speedBonusMultiplier);
      const gain = 6 + adjustedSpeedBonus;
      const delta = Math.max(1, Math.round((gain - 3) / 2));
      if (fasterSeat === 1) {
        sharedPossession += delta;
        momentum1 += 1;
      } else {
        sharedPossession -= delta;
        momentum2 += 1;
      }
    }
  }

  state.sharedPossession = clamp(sharedPossession, 0, 100);
  state.seatMomentum = {
    seat1: clamp(momentum1, 0, 6),
    seat2: clamp(momentum2, 0, 6),
  };

  state.normalQuestionsAnsweredInHalf += 1;
  state.normalQuestionsAnsweredTotal += 1;
  state.currentQuestion = null;

  logger.info({
    normalQIn: state.normalQuestionsAnsweredInHalf,
    normalQTotal: state.normalQuestionsAnsweredTotal,
    normalQPerHalf: state.normalQuestionsPerHalf,
    half: state.half,
    possession: state.sharedPossession,
    momentum: state.seatMomentum,
    seat1Correct: seat1Answer.isCorrect,
    seat2Correct: seat2Answer.isCorrect,
  }, 'applyNormalResolution: post-increment state');

  // Check if the half is over BEFORE checking for shots.
  // Without this ordering, a shot trigger on the last question of a half
  // would skip the halftime/completion check entirely, causing the game
  // to loop indefinitely past the expected number of questions.
  if (state.normalQuestionsAnsweredInHalf >= state.normalQuestionsPerHalf) {
    if (state.half === 1) {
      logger.info({ normalQIn: state.normalQuestionsAnsweredInHalf, half: 1 }, 'applyNormalResolution → HALFTIME');
      state.phase = 'HALFTIME';
      state.halftime.deadlineAt = new Date(Date.now() + HALFTIME_DURATION_MS).toISOString();
      return;
    }

    if (state.goals.seat1 === state.goals.seat2) {
      logger.info({ goals: state.goals }, 'applyNormalResolution → PENALTY_SHOOTOUT');
      state.phase = 'PENALTY_SHOOTOUT';
      state.penalty.round = 1;
      state.penalty.shooterSeat = 1;
      state.penalty.suddenDeath = false;
      state.penalty.kicksTaken = { seat1: 0, seat2: 0 };
      return;
    }

    logger.info({ goals: state.goals }, 'applyNormalResolution → COMPLETED');
    state.phase = 'COMPLETED';
    return;
  }

  const triggerAttacker = determineShotAttackerSeat(state);
  if (triggerAttacker) {
    logger.info({
      triggerAttacker,
      possession: state.sharedPossession,
      momentum: state.seatMomentum,
      normalQIn: state.normalQuestionsAnsweredInHalf,
    }, 'applyNormalResolution → SHOT_ON_GOAL');
    state.phase = 'SHOT_ON_GOAL';
    state.shot.attackerSeat = triggerAttacker;
    return;
  }

  logger.info({ normalQIn: state.normalQuestionsAnsweredInHalf }, 'applyNormalResolution → NORMAL_PLAY');
  state.phase = 'NORMAL_PLAY';
}

async function applyShotResolution(
  matchId: string,
  state: PossessionStatePayload,
  players: Array<{ user_id: string; seat: number }>,
  answerByUserId: Map<string, { is_correct: boolean }>
): Promise<void> {
  const attackerSeat = state.shot.attackerSeat ?? (state.sharedPossession >= 50 ? 1 : 2);
  const defenderSeat = nextSeat(attackerSeat);

  const attackerUserId = getUserIdBySeat(players, attackerSeat);
  const defenderUserId = getUserIdBySeat(players, defenderSeat);
  if (!attackerUserId || !defenderUserId) {
    state.phase = 'NORMAL_PLAY';
    state.currentQuestion = null;
    state.shot.attackerSeat = null;
    return;
  }

  const attackerCorrect = answerByUserId.get(attackerUserId)?.is_correct ?? false;
  const defenderCorrect = answerByUserId.get(defenderUserId)?.is_correct ?? false;

  if (attackerCorrect && !defenderCorrect) {
    if (attackerSeat === 1) state.goals.seat1 += 1;
    else state.goals.seat2 += 1;
    await matchesRepo.updatePlayerGoalTotals(matchId, attackerUserId, { goals: 1 });
    state.sharedPossession = 50;
    // Conceding team gets kick-off after a goal (like real football)
    state.kickOffSeat = defenderSeat;
  } else {
    state.sharedPossession = shotReboundPossession(attackerSeat);
  }

  // Momentum reset is immediate after shot resolution.
  state.seatMomentum = { seat1: 0, seat2: 0 };
  state.phase = 'NORMAL_PLAY';
  state.currentQuestion = null;
  state.shot.attackerSeat = null;
}

function penaltyWinnerSeat(state: PossessionStatePayload): Seat | null {
  const p1 = state.penaltyGoals.seat1;
  const p2 = state.penaltyGoals.seat2;
  const k1 = state.penalty.kicksTaken.seat1;
  const k2 = state.penalty.kicksTaken.seat2;

  const rem1 = Math.max(0, 5 - k1);
  const rem2 = Math.max(0, 5 - k2);

  if (p1 > p2 + rem2) return 1;
  if (p2 > p1 + rem1) return 2;

  if (k1 >= 5 && k2 >= 5 && k1 === k2 && p1 !== p2) {
    return p1 > p2 ? 1 : 2;
  }

  return null;
}

async function applyPenaltyResolution(
  matchId: string,
  state: PossessionStatePayload,
  players: Array<{ user_id: string; seat: number }>,
  answerByUserId: Map<string, { is_correct: boolean; time_ms: number }>,
  shooterSeat: Seat
): Promise<void> {
  const keeperSeat = nextSeat(shooterSeat);
  const shooterUserId = getUserIdBySeat(players, shooterSeat);
  const keeperUserId = getUserIdBySeat(players, keeperSeat);
  if (!shooterUserId) {
    state.phase = 'COMPLETED';
    state.currentQuestion = null;
    return;
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

  if (isGoal) {
    if (shooterSeat === 1) state.penaltyGoals.seat1 += 1;
    else state.penaltyGoals.seat2 += 1;
    await matchesRepo.updatePlayerGoalTotals(matchId, shooterUserId, { penaltyGoals: 1 });
  }

  if (shooterSeat === 1) state.penalty.kicksTaken.seat1 += 1;
  else state.penalty.kicksTaken.seat2 += 1;

  const winnerSeat = penaltyWinnerSeat(state);
  if (winnerSeat) {
    state.phase = 'COMPLETED';
    state.currentQuestion = null;
    return;
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
}

export async function resolvePossessionRound(
  io: QuizballServer,
  matchId: string,
  qIndex: number,
  fromTimeout = false
): Promise<void> {
  const lockKey = `lock:match:${matchId}:resolve`;
  const lock = await acquireLock(lockKey, 5000);
  if (!lock.acquired || !lock.token) return;

  try {
    const match = await matchesRepo.getMatch(matchId);
    if (!match || match.status !== 'active' || match.engine !== 'possession_v1') return;
    if (match.current_q_index > qIndex) return;

    const questionPayload = await matchesService.buildMatchQuestionPayload(matchId, qIndex);
    if (!questionPayload) return;

    const expected = await getExpectedAnswersForQuestion(matchId, qIndex);
    if (!expected) return;

    const players = await matchesRepo.listMatchPlayers(matchId);
    const answers = await matchesRepo.listAnswersForQuestion(matchId, qIndex);
    const answeredUserIds = new Set(answers.map((answer) => answer.user_id));

    if (!fromTimeout && answers.length < expected.expectedUserIds.length) {
      return;
    }

    for (const userId of expected.expectedUserIds) {
      if (answeredUserIds.has(userId)) continue;
      await matchesRepo.insertMatchAnswer({
        matchId,
        qIndex,
        userId,
        selectedIndex: null,
        isCorrect: false,
        timeMs: QUESTION_TIME_MS,
        pointsEarned: 0,
        phaseKind: questionPayload.phaseKind,
        phaseRound: questionPayload.phaseRound,
        shooterSeat: questionPayload.shooterSeat,
      });
    }

    const finalAnswers = await matchesRepo.listAnswersForQuestion(matchId, qIndex);
    const playerRows = await matchesRepo.listMatchPlayers(matchId);

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

    io.to(`match:${matchId}`).emit('match:round_result', {
      matchId,
      qIndex,
      correctIndex: questionPayload.correctIndex,
      players: playersPayload,
      phaseKind: questionPayload.phaseKind,
      phaseRound: questionPayload.phaseRound,
      shooterSeat: questionPayload.shooterSeat,
      attackerSeat: questionPayload.attackerSeat,
    });

    const state = parsePossessionState(match.state_payload);
    const answerByUserId = new Map(finalAnswers.map((answer) => [
      answer.user_id,
      {
        is_correct: answer.is_correct,
        time_ms: answer.time_ms,
      },
    ]));

    if (questionPayload.phaseKind === 'normal') {
      const seat1UserId = getUserIdBySeat(players, 1);
      const seat2UserId = getUserIdBySeat(players, 2);
      const seat1Answer = seat1UserId
        ? {
          isCorrect: answerByUserId.get(seat1UserId)?.is_correct ?? false,
          timeMs: answerByUserId.get(seat1UserId)?.time_ms ?? QUESTION_TIME_MS,
        }
        : { isCorrect: false, timeMs: QUESTION_TIME_MS };
      const seat2Answer = seat2UserId
        ? {
          isCorrect: answerByUserId.get(seat2UserId)?.is_correct ?? false,
          timeMs: answerByUserId.get(seat2UserId)?.time_ms ?? QUESTION_TIME_MS,
        }
        : { isCorrect: false, timeMs: QUESTION_TIME_MS };

      applyNormalResolution(state, seat1Answer, seat2Answer);
    } else if (questionPayload.phaseKind === 'shot') {
      await applyShotResolution(
        matchId,
        state,
        players,
        new Map(finalAnswers.map((answer) => [answer.user_id, { is_correct: answer.is_correct }]))
      );
    } else {
      await applyPenaltyResolution(
        matchId,
        state,
        players,
        new Map(finalAnswers.map((answer) => [answer.user_id, { is_correct: answer.is_correct, time_ms: answer.time_ms }])),
        asSeat(questionPayload.shooterSeat) ?? state.penalty.shooterSeat
      );
    }

    state.currentQuestion = null;

    const nextIndex = qIndex + 1;
    await matchesRepo.setMatchStatePayload(matchId, state, nextIndex);
    await emitMatchState(io, matchId, state);

    if (state.phase === 'HALFTIME') {
      scheduleHalftimeTimeout(io, matchId);
      return;
    }

    if (state.phase === 'COMPLETED') {
      await completePossessionMatch(io, matchId, state);
      return;
    }

    setTimeout(() => {
      void sendPossessionMatchQuestion(io, matchId, nextIndex).catch((error) => {
        logger.error({ error, matchId, nextIndex }, 'Failed to send next possession question');
      });
    }, ROUND_RESULT_DELAY_MS);
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
  const { matchId, qIndex, selectedIndex, timeMs } = payload;

  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'active' || match.engine !== 'possession_v1') {
    return;
  }

  if (match.current_q_index !== qIndex) {
    return;
  }

  const players = await matchesRepo.listMatchPlayers(matchId);
  const mySeat = getSeatFromUserId(players, socket.data.user.id);
  if (!mySeat) return;

  const questionPayload = await matchesService.buildMatchQuestionPayload(matchId, qIndex);
  if (!questionPayload) return;

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

  const existing = await matchesRepo.getAnswerForUser(matchId, qIndex, socket.data.user.id);
  if (existing) return;

  const questionTiming = await matchesRepo.getMatchQuestionTiming(matchId, qIndex);
  const authoritativeTimeMs = questionTiming
    ? toAuthoritativeTimeMs(questionTiming, Date.now(), timeMs)
    : clamp(timeMs, 0, QUESTION_TIME_MS);

  const isCorrect = selectedIndex !== null && selectedIndex === questionPayload.correctIndex;
  const pointsEarned = calculatePoints(isCorrect, authoritativeTimeMs, QUESTION_TIME_MS);

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

  const expected = await getExpectedAnswersForQuestion(matchId, qIndex);
  const answers = await matchesRepo.listAnswersForQuestion(matchId, qIndex);

  const shouldWaitForOpponent = expected
    ? expected.expectedUserIds.length > 1 && answers.length < expected.expectedUserIds.length
    : false;

  socket.emit('match:answer_ack', {
    matchId,
    qIndex,
    selectedIndex,
    isCorrect,
    correctIndex: questionPayload.correctIndex,
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
      opponentTotalPoints: updatedPlayer.total_points,
      pointsEarned,
      isCorrect,
    });
  }

  if (expected && answers.length >= expected.expectedUserIds.length) {
    await resolvePossessionRound(io, matchId, qIndex, false);
  }
}

export function cancelPossessionQuestionTimer(matchId: string, qIndex: number): void {
  clearQuestionTimer(matchId, qIndex);
  clearAiAnswerTimer(matchId, qIndex);
}

export function cancelPossessionHalftimeTimer(matchId: string): void {
  clearHalftimeTimer(matchId);
  aiUserIdByMatch.delete(matchId);
}

export async function devSkipToPossessionPhase(
  io: QuizballServer,
  matchId: string,
  target: 'halftime' | 'shot' | 'penalties' | 'second_half'
): Promise<void> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'active' || match.engine !== 'possession_v1') return;

  // Cancel all active timers
  clearQuestionTimer(matchId, match.current_q_index);
  clearAiAnswerTimer(matchId, match.current_q_index);
  clearHalftimeTimer(matchId);

  const state = parsePossessionState(match.state_payload);
  const nextQIndex = match.current_q_index + 1;

  switch (target) {
    case 'halftime':
      state.normalQuestionsAnsweredInHalf = POSSESSION_QUESTIONS_PER_HALF;
      state.phase = 'HALFTIME';
      state.halftime.deadlineAt = new Date(Date.now() + HALFTIME_DURATION_MS).toISOString();
      state.currentQuestion = null;
      break;

    case 'second_half':
      state.half = 2;
      state.phase = 'NORMAL_PLAY';
      state.sharedPossession = 50;
      state.seatMomentum = { seat1: 0, seat2: 0 };
      state.kickOffSeat = nextSeat(state.kickOffSeat);
      state.shot.attackerSeat = null;
      state.normalQuestionsAnsweredInHalf = 0;
      state.halftime.tactics.seat1 = state.halftime.tactics.seat1 ?? 'play-safe';
      state.halftime.tactics.seat2 = state.halftime.tactics.seat2 ?? 'play-safe';
      state.halftime.deadlineAt = null;
      state.currentQuestion = null;
      break;

    case 'shot':
      state.phase = 'SHOT_ON_GOAL';
      state.shot.attackerSeat = 1;
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

  await matchesRepo.setMatchStatePayload(matchId, state, nextQIndex);
  await emitMatchState(io, matchId, state);

  if (target === 'halftime') {
    scheduleHalftimeTimeout(io, matchId);
  } else {
    await sendPossessionMatchQuestion(io, matchId, nextQIndex);
  }

  logger.info({ matchId, target, phase: state.phase }, 'Dev skip: state modified');
}

export const __possessionInternals = {
  parsePossessionState,
  determineShotAttackerSeat,
  shotReboundPossession,
  applyNormalResolution,
  penaltyWinnerSeat,
  decideWinner,
};
