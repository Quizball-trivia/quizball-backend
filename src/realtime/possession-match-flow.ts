import { trackEvent } from '../core/analytics.js';
import { BadRequestError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { lobbiesService } from '../modules/lobbies/lobbies.service.js';
import { achievementsService } from '../modules/achievements/index.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import { rankedService } from '../modules/ranked/ranked.service.js';
import { storeService } from '../modules/store/store.service.js';
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
import {
  answerCount,
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
import { getRedisClient } from './redis.js';
import type { QuizballServer, QuizballSocket } from './socket-server.js';
import type { DraftCategory, MatchPhaseKind, MatchRoundResultDeltas, MatchStatePayload } from './socket.types.js';
import { clamp, calculatePoints } from './scoring.js';

const QUESTION_TIME_MS = 10000;
const FRONTEND_REVEAL_MS = 3000; // Frontend shows question text before unlocking options
const FRONTEND_TRANSITION_MS = 3500; // Frontend round-transition overlay between questions
const FRONTEND_TRANSITION_DELAY_MS = 1600; // Synced with frontend TRANSITION_DELAY_MS
const FRONTEND_RESULT_HOLD_MS = 2500; // Synced with frontend ROUND_RESULT_HOLD_MS
const FRONTEND_FIRST_QUESTION_INTRO_MS = 2000; // Synced with first-question intro overlay
const ROUND_RESULT_DELAY_MS = 0;
const PENALTY_INTRO_DELAY_MS = 1000;
const TIMEOUT_RESOLVE_GRACE_MS = 250;
const TIMEOUT_RESOLVE_BUFFER_MS = 50;
const HALFTIME_DURATION_MS = 20000;
const HALFTIME_POST_BAN_REVEAL_MS = 2000;
const HALFTIME_AI_BAN_DELAY_MIN_MS = 700;
const HALFTIME_AI_BAN_DELAY_MAX_MS = 1800;
const LAST_MATCH_REPLAY_TTL_SEC = 600;
const TIMING_DISCREPANCY_WARN_MS = 500;

const questionTimers = new Map<string, NodeJS.Timeout>();
const halftimeTimers = new Map<string, NodeJS.Timeout>();
const halftimeAiBanTimers = new Map<string, NodeJS.Timeout>();
const aiAnswerTimers = new Map<string, NodeJS.Timeout>();
const aiUserIdByMatch = new Map<string, string | null>();
const aiCorrectnessForMatch = new Map<string, number>();

type Seat = 1 | 2;

type ResolutionDecision = {
  winnerId: string | null;
  method: 'goals' | 'penalty_goals' | 'total_points_fallback';
  totalPointsFallbackUsed: boolean;
};

type ExpectedAnswerInfo = {
  expectedUserIds: string[];
  shooterSeat: Seat | null;
  attackerSeat: Seat | null;
};

function timerKey(matchId: string, qIndex: number): string {
  return `${matchId}:${qIndex}`;
}

function effectiveAnswerTimeMs(authoritativeTimeMs: number): number {
  return Math.max(0, authoritativeTimeMs - FRONTEND_REVEAL_MS);
}

function lastMatchKey(userId: string): string {
  return `user:last_match:${userId}`;
}

function getAiAnswerDelayMs(): number {
  // AI "thinking" time after options become visible to players.
  // Range: 2–7s => 80..30 points on correct answers.
  return Math.floor(Math.random() * 5000) + 2000;
}

function getAiPreAnswerDelayMs(params: {
  qIndex: number;
  state: Pick<PossessionStatePayload, 'half' | 'normalQuestionsAnsweredInHalf'>;
}): number {
  const { qIndex, state } = params;
  // First question has a dedicated intro overlay before reveal.
  if (qIndex === 0) {
    return FRONTEND_FIRST_QUESTION_INTRO_MS + FRONTEND_REVEAL_MS;
  }
  // First question after halftime does not have round-result transition blockers.
  if (state.half === 2 && state.normalQuestionsAnsweredInHalf === 0) {
    return FRONTEND_REVEAL_MS;
  }
  // Subsequent questions are blocked by result hold + transition overlay + reveal.
  return FRONTEND_RESULT_HOLD_MS + FRONTEND_TRANSITION_DELAY_MS + FRONTEND_REVEAL_MS;
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

const VALID_PHASE_KINDS: ReadonlySet<MatchPhaseKind> = new Set(['normal', 'last_attack', 'penalty']);

function isMatchPhaseKind(value: unknown): value is MatchPhaseKind {
  return typeof value === 'string' && VALID_PHASE_KINDS.has(value as MatchPhaseKind);
}

function parsePossessionState(raw: unknown): PossessionStatePayload {
  const fallbackVariant =
    raw && typeof raw === 'object' && (raw as Partial<PossessionStatePayload>).variant === 'ranked_sim'
      ? 'ranked_sim'
      : 'friendly_possession';
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return createInitialPossessionState(fallbackVariant); }
  }
  if (!raw || typeof raw !== 'object') {
    return createInitialPossessionState(fallbackVariant);
  }

  const candidate = raw as Partial<PossessionStatePayload>;
  const fallback = createInitialPossessionState(fallbackVariant);

  if (!candidate.phase || !candidate.half || !candidate.goals || !candidate.penaltyGoals) {
    return fallback;
  }

  return {
    ...fallback,
    ...candidate,
    goals: {
      seat1: Math.max(0, Number(candidate.goals.seat1 ?? fallback.goals.seat1)),
      seat2: Math.max(0, Number(candidate.goals.seat2 ?? fallback.goals.seat2)),
    },
    penaltyGoals: {
      seat1: Math.max(0, Number(candidate.penaltyGoals.seat1 ?? fallback.penaltyGoals.seat1)),
      seat2: Math.max(0, Number(candidate.penaltyGoals.seat2 ?? fallback.penaltyGoals.seat2)),
    },
    possessionDiff: clamp(Number(candidate.possessionDiff ?? fallback.possessionDiff), -100, 100),
    kickOffSeat: asSeat(candidate.kickOffSeat) ?? fallback.kickOffSeat,
    normalQuestionsPerHalf: POSSESSION_QUESTIONS_PER_HALF,
    normalQuestionsAnsweredInHalf: Math.max(0, Number(candidate.normalQuestionsAnsweredInHalf ?? 0)),
    normalQuestionsAnsweredTotal: Math.max(0, Number(candidate.normalQuestionsAnsweredTotal ?? 0)),
    halftime: {
      deadlineAt: candidate.halftime?.deadlineAt ?? null,
      categoryOptions: Array.isArray(candidate.halftime?.categoryOptions)
        ? candidate.halftime.categoryOptions.reduce<DraftCategory[]>((acc, category) => {
          if (!category || typeof category !== 'object') return acc;
          if (typeof category.id !== 'string' || typeof category.name !== 'string') return acc;
          const legacyImageUrl = (category as { image_url?: unknown }).image_url;
          acc.push({
            id: category.id,
            name: category.name,
            icon: typeof category.icon === 'string' ? category.icon : null,
            imageUrl:
              typeof category.imageUrl === 'string'
                ? category.imageUrl
                : typeof legacyImageUrl === 'string'
                  ? legacyImageUrl
                  : null,
          });
          return acc;
        }, [])
        : [],
      firstHalfShownCategoryIds: Array.isArray(candidate.halftime?.firstHalfShownCategoryIds)
        ? candidate.halftime.firstHalfShownCategoryIds.filter((categoryId): categoryId is string => typeof categoryId === 'string')
        : [],
      firstBanSeat: asSeat(candidate.halftime?.firstBanSeat),
      bans: {
        seat1: typeof candidate.halftime?.bans?.seat1 === 'string' ? candidate.halftime.bans.seat1 : null,
        seat2: typeof candidate.halftime?.bans?.seat2 === 'string' ? candidate.halftime.bans.seat2 : null,
      },
    },
    lastAttack: {
      attackerSeat: asSeat(candidate.lastAttack?.attackerSeat),
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
        phaseKind: isMatchPhaseKind(candidate.currentQuestion.phaseKind) ? candidate.currentQuestion.phaseKind : 'normal',
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
  if (state.phase === 'LAST_ATTACK') return 'last_attack';
  if (state.phase === 'PENALTY_SHOOTOUT') return 'penalty';
  return 'normal';
}

function getDifficultyForState(state: PossessionStatePayload): Array<'easy' | 'medium' | 'hard'> {
  const phaseKind = phaseKindFromState(state);
  if (phaseKind === 'penalty') return ['hard'];

  const p = Math.abs(state.possessionDiff);
  if (p <= 20) return ['easy'];
  if (p <= 45) return ['easy', 'medium'];
  if (p <= 70) return ['medium'];
  return ['medium', 'hard'];
}

function toMatchStatePayload(matchId: string, state: PossessionStatePayload): MatchStatePayload {
  const phaseKind = state.currentQuestion?.phaseKind ?? phaseKindFromState(state);
  const phaseRound = state.currentQuestion?.phaseRound
    ?? (state.phase === 'PENALTY_SHOOTOUT' ? Math.ceil(state.penalty.round / 2) : 0);
  return {
    matchId,
    phase: state.phase,
    half: state.half,
    possessionDiff: state.possessionDiff,
    normalQuestionsAnsweredInHalf: state.normalQuestionsAnsweredInHalf,
    attackerSeat: state.lastAttack.attackerSeat,
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
    halftime: {
      deadlineAt: state.halftime.deadlineAt,
      categoryOptions: state.halftime.categoryOptions,
      firstBanSeat: state.halftime.firstBanSeat,
      bans: {
        seat1: state.halftime.bans.seat1,
        seat2: state.halftime.bans.seat2,
      },
    },
    penaltySuddenDeath: state.penalty.suddenDeath,
    stateVersion: state.stateVersionCounter,
  };
}

function bumpStateVersion(state: PossessionStatePayload): void {
  const next = Number(state.stateVersionCounter);
  state.stateVersionCounter = Number.isFinite(next) ? next + 1 : 1;
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
  if (timer) {
    clearTimeout(timer);
    halftimeTimers.delete(matchId);
  }
  clearHalftimeAiBanTimer(matchId);
}

function getHalftimeAiBanDelayMs(): number {
  return Math.floor(Math.random() * (HALFTIME_AI_BAN_DELAY_MAX_MS - HALFTIME_AI_BAN_DELAY_MIN_MS + 1))
    + HALFTIME_AI_BAN_DELAY_MIN_MS;
}

function clearHalftimeAiBanTimer(matchId: string): void {
  const timer = halftimeAiBanTimers.get(matchId);
  if (!timer) return;
  clearTimeout(timer);
  halftimeAiBanTimers.delete(matchId);
}

function scheduleQuestionTimeout(io: QuizballServer, matchId: string, qIndex: number): void {
  const key = timerKey(matchId, qIndex);
  const existing = questionTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  // Budget: transition overlay (3.5s) + question reveal (3s) + answer timer (10s) + grace (0.3s)
  const timeout = setTimeout(() => {
    void resolvePossessionRound(io, matchId, qIndex, true).catch((error) => {
      logger.error({ error, matchId, qIndex }, 'Failed to resolve possession round after timeout');
    });
  }, QUESTION_TIME_MS + FRONTEND_REVEAL_MS + FRONTEND_TRANSITION_MS + TIMEOUT_RESOLVE_GRACE_MS + TIMEOUT_RESOLVE_BUFFER_MS);

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
  return computeAuthoritativeTimeMs(
    { shownAt: questionTiming.shown_at, deadlineAt: questionTiming.deadline_at },
    nowMs,
    fallbackTimeMs
  );
}

function toAuthoritativeTimeMsFromCache(
  questionTiming: {
    shownAt: string | null;
    deadlineAt: string | null;
  },
  nowMs: number,
  fallbackTimeMs: number
): number {
  return computeAuthoritativeTimeMs(questionTiming, nowMs, fallbackTimeMs);
}

function computeAuthoritativeTimeMs(
  questionTiming: {
    shownAt: string | null;
    deadlineAt: string | null;
  },
  nowMs: number,
  fallbackTimeMs: number
): number {
  if (questionTiming.shownAt) {
    const shownAtMs = new Date(questionTiming.shownAt).getTime();
    if (Number.isFinite(shownAtMs)) {
      return clamp(Math.round(nowMs - shownAtMs), 0, QUESTION_TIME_MS);
    }
  }

  if (questionTiming.deadlineAt) {
    const deadlineMs = new Date(questionTiming.deadlineAt).getTime();
    if (Number.isFinite(deadlineMs)) {
      return clamp(Math.round(QUESTION_TIME_MS - (deadlineMs - nowMs)), 0, QUESTION_TIME_MS);
    }
  }

  return clamp(Math.round(fallbackTimeMs), 0, QUESTION_TIME_MS);
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
}> {
  const payload: Record<string, {
    selectedIndex: number | null;
    isCorrect: boolean;
    timeMs: number;
    pointsEarned: number;
    totalPoints: number;
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
    };
  }
  return payload;
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

async function resolveAiCorrectnessForMatch(matchId: string): Promise<number> {
  const cached = aiCorrectnessForMatch.get(matchId);
  if (cached !== undefined) return cached;

  const match = await matchesRepo.getMatch(matchId);
  const ctx = match?.ranked_context;
  if (ctx && typeof ctx === 'object' && 'aiCorrectness' in ctx) {
    const val = (ctx as { aiCorrectness?: unknown }).aiCorrectness;
    if (typeof val === 'number') {
      aiCorrectnessForMatch.set(matchId, val);
      return val;
    }
  }

  aiCorrectnessForMatch.set(matchId, RANKED_AI_CORRECTNESS);
  return RANKED_AI_CORRECTNESS;
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
  const cache = await getMatchCacheOrRebuild(matchId);
  if (!cache || cache.status !== 'active') return;
  if (cache.currentQIndex !== qIndex) return;
  if (!cache.currentQuestion) return;

  const aiUserId = await resolveAiUserIdForMatch(matchId);
  if (!aiUserId) return;

  const hasAi = cache.players.some((player) => player.userId === aiUserId);
  if (!hasAi) return;

  const expectedUserIds = getExpectedUserIds(cache);
  if (!expectedUserIds.includes(aiUserId)) return;

  const aiThinkTimeMs = getAiAnswerDelayMs();
  const preAnswerDelayMs = getAiPreAnswerDelayMs({
    qIndex,
    state: cache.statePayload,
  });
  const delayMs = preAnswerDelayMs + aiThinkTimeMs;
  const aiCorrectness = await resolveAiCorrectnessForMatch(matchId);
  const timeout = setTimeout(() => {
    const stored = aiAnswerTimers.get(key);
    if (stored) {
      clearTimeout(stored);
      aiAnswerTimers.delete(key);
    }

    void (async () => {
      try {
        const lockKey = `lock:match:${matchId}:answer`;
        const lock = await acquireLock(lockKey, 2000);
        if (!lock.acquired || !lock.token) return;

        let committed: {
          selectedIndex: number | null;
          isCorrect: boolean;
          answerTimeMs: number;
          pointsEarned: number;
          totalPoints: number;
          phaseKind: MatchPhaseKind;
          phaseRound: number | null;
          shooterSeat: Seat | null;
          answerCount: number;
          expectedCount: number;
        } | null = null;

        try {
          const fresh = await getMatchCacheOrRebuild(matchId);
          if (!fresh || fresh.status !== 'active') return;
          if (fresh.currentQIndex !== qIndex || !fresh.currentQuestion) return;
          if (hasUserAnswered(fresh, aiUserId)) return;

          const expected = getExpectedUserIds(fresh);
          if (!expected.includes(aiUserId)) return;

          const isCorrect = Math.random() < aiCorrectness;
          const selectedIndex = isCorrect
            ? options.correctIndex
            : pickIncorrectIndex(options.correctIndex, options.optionCount);
          const answerTimeMs = clamp(aiThinkTimeMs, 0, QUESTION_TIME_MS);
          const pointsEarned = calculatePoints(isCorrect, answerTimeMs, QUESTION_TIME_MS);
          const question = fresh.currentQuestion;
          const aiPlayer = getCachedPlayer(fresh, aiUserId);
          if (!aiPlayer) return;

          const answer: CachedAnswer = {
            userId: aiUserId,
            selectedIndex,
            isCorrect,
            timeMs: answerTimeMs,
            pointsEarned,
            phaseKind: question.phaseKind,
            phaseRound: question.phaseRound,
            shooterSeat: question.shooterSeat,
            answeredAt: new Date().toISOString(),
          };

          fresh.answers[aiUserId] = answer;
          aiPlayer.totalPoints += pointsEarned;
          if (isCorrect) aiPlayer.correctAnswers += 1;

          await setMatchCache(fresh);

          committed = {
            selectedIndex,
            isCorrect,
            answerTimeMs,
            pointsEarned,
            totalPoints: aiPlayer.totalPoints,
            phaseKind: question.phaseKind,
            phaseRound: question.phaseRound,
            shooterSeat: question.shooterSeat,
            answerCount: answerCount(fresh),
            expectedCount: expected.length,
          };
        } finally {
          await releaseLock(lockKey, lock.token);
        }

        if (!committed) return;

        fireAndForget('insertMatchAnswer(ai)', async () => {
          await matchesRepo.insertMatchAnswerIfMissing({
            matchId,
            qIndex,
            userId: aiUserId,
            selectedIndex: committed.selectedIndex,
            isCorrect: committed.isCorrect,
            timeMs: committed.answerTimeMs,
            pointsEarned: committed.pointsEarned,
            phaseKind: committed.phaseKind,
            phaseRound: committed.phaseRound,
            shooterSeat: committed.shooterSeat,
          });
        });

        fireAndForget('updatePlayerTotals(ai)', async () => {
          await matchesRepo.updatePlayerTotals(
            matchId,
            aiUserId,
            committed.pointsEarned,
            committed.isCorrect
          );
        });

        if (committed.phaseKind !== 'penalty') {
          io.to(`match:${matchId}`).emit('match:opponent_answered', {
            matchId,
            qIndex,
            opponentTotalPoints: committed.totalPoints,
            pointsEarned: committed.pointsEarned,
            isCorrect: committed.isCorrect,
            selectedIndex: committed.selectedIndex,
          });
        }

        if (committed.answerCount >= committed.expectedCount) {
          await resolvePossessionRound(io, matchId, qIndex, false);
        }
      } catch (error) {
        logger.warn({ error, matchId, qIndex }, 'Possession AI answer scheduling failed');
      }
    })();
  }, delayMs);

  aiAnswerTimers.set(key, timeout);
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

function transitionAfterHalfBoundary(state: PossessionStatePayload): void {
  if (state.half === 1) {
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
    try {
      rankedOutcome = await rankedService.settleCompletedRankedMatch(matchId);
      logger.info({ matchId, hasOutcome: rankedOutcome != null, userIds: rankedOutcome ? Object.keys(rankedOutcome.byUserId) : [] }, 'Ranked settlement result for final_results emit');
    } catch (err) {
      logger.warn({ err, matchId }, 'Ranked settlement failed — emitting results without rankedOutcome');
    }
  }

  const unlockedAchievements = await achievementsService.evaluateForMatch(
    matchId,
    refreshedPlayers.map((player) => player.user_id)
  );

  io.to(`match:${matchId}`).emit('match:final_results', {
    matchId,
    winnerId: decision.winnerId,
    players: payloadPlayers,
    unlockedAchievements,
    durationMs,
    resultVersion,
    winnerDecisionMethod: decision.method,
    totalPointsFallbackUsed: decision.totalPointsFallbackUsed,
    ...(rankedOutcome ? { rankedOutcome } : {}),
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
  aiCorrectnessForMatch.delete(matchId);
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
} | null> {
  const preferredDifficulties = getDifficultyForState(state);

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

function categoryIdsForCurrentHalf(
  state: Pick<PossessionStatePayload, 'half'>,
  cache: Pick<MatchCache, 'categoryAId' | 'categoryBId'>
): string[] {
  if (state.half === 1) return [cache.categoryAId];
  return cache.categoryBId ? [cache.categoryBId] : [cache.categoryAId];
}

function seatToBanKey(seat: Seat): 'seat1' | 'seat2' {
  return seat === 1 ? 'seat1' : 'seat2';
}

function getHalftimeTurnSeat(state: PossessionStatePayload): Seat | null {
  const firstSeat = state.halftime.firstBanSeat ?? 2;
  const secondSeat = nextSeat(firstSeat);
  const firstKey = seatToBanKey(firstSeat);
  const secondKey = seatToBanKey(secondSeat);

  if (!state.halftime.bans[firstKey]) return firstSeat;
  if (!state.halftime.bans[secondKey]) return secondSeat;
  return null;
}

function uniqueDraftCategories(categories: DraftCategory[]): DraftCategory[] {
  const seen = new Set<string>();
  const unique: DraftCategory[] = [];
  for (const category of categories) {
    if (seen.has(category.id)) continue;
    seen.add(category.id);
    unique.push(category);
  }
  return unique;
}

async function ensureHalftimeCategories(
  state: PossessionStatePayload,
  categoryAId: string,
  matchId: string
): Promise<void> {
  if (state.halftime.categoryOptions.length >= 3) return;
  try {
    const match = await matchesRepo.getMatch(matchId);
    const lobbyId = match?.lobby_id ?? null;

    if (!state.halftime.firstBanSeat) {
      state.halftime.firstBanSeat = match?.is_dev
        ? (Math.random() < 0.5 ? 1 : 2)
        : 2;
    }

    if (!Array.isArray(state.halftime.firstHalfShownCategoryIds) || state.halftime.firstHalfShownCategoryIds.length === 0) {
      if (lobbyId) {
        const firstHalfOptions = await lobbiesService.getLobbyCategories(lobbyId);
        state.halftime.firstHalfShownCategoryIds = uniqueDraftCategories(firstHalfOptions).map((category) => category.id);
      } else {
        state.halftime.firstHalfShownCategoryIds = [];
      }
    }

    const excludedIds = new Set<string>([categoryAId, ...state.halftime.firstHalfShownCategoryIds]);
    const primary = await lobbiesService.selectRandomCategoriesExcluding(3, Array.from(excludedIds));
    let categories = uniqueDraftCategories(primary).filter((category) => !excludedIds.has(category.id));

    if (categories.length < 3) {
      const fallback = await lobbiesService.selectRandomCategories(9);
      categories = uniqueDraftCategories([...categories, ...fallback]).filter((category) => !excludedIds.has(category.id));
    }

    if (categories.length < 3) {
      logger.warn(
        {
          matchId,
          firstHalfShownCategoryIds: state.halftime.firstHalfShownCategoryIds,
          categoryAId,
          availableCount: categories.length,
        },
        'Insufficient unique halftime categories excluding first-half draft categories; relaxing exclusion'
      );
      const relaxed = await lobbiesService.selectRandomCategoriesExcluding(3, [categoryAId]);
      categories = uniqueDraftCategories([...categories, ...relaxed]).filter((category) => category.id !== categoryAId);
    }

    state.halftime.categoryOptions = categories.slice(0, 3);
    state.halftime.bans = { seat1: null, seat2: null };
  } catch (error) {
    logger.error({ error }, 'Failed to initialize halftime category options');
    state.halftime.categoryOptions = [];
    state.halftime.bans = { seat1: null, seat2: null };
  }
}

function pickRandomCategoryId(
  categoryIds: string[],
  excludedCategoryIds: Set<string>
): string | null {
  const candidates = categoryIds.filter((categoryId) => !excludedCategoryIds.has(categoryId));
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
}

function resolveHalftimeResult(
  state: PossessionStatePayload
): {
  seat1Ban: string | null;
  seat2Ban: string | null;
  remainingCategoryId: string | null;
} {
  const categoryIds = state.halftime.categoryOptions.map((category) => category.id);
  if (categoryIds.length === 0) {
    return { seat1Ban: null, seat2Ban: null, remainingCategoryId: null };
  }

  const validCategoryIds = new Set(categoryIds);
  let seat1Ban = validCategoryIds.has(state.halftime.bans.seat1 ?? '') ? state.halftime.bans.seat1 : null;
  let seat2Ban = validCategoryIds.has(state.halftime.bans.seat2 ?? '') ? state.halftime.bans.seat2 : null;

  if (!seat1Ban) {
    seat1Ban = pickRandomCategoryId(categoryIds, new Set()) ?? null;
  }

  const seat2Preferred = seat2Ban && seat2Ban !== seat1Ban ? seat2Ban : null;
  if (!seat2Preferred) {
    seat2Ban = pickRandomCategoryId(categoryIds, new Set(seat1Ban ? [seat1Ban] : []));
    if (!seat2Ban) {
      seat2Ban = pickRandomCategoryId(categoryIds, new Set()) ?? seat2Ban;
    }
  } else {
    seat2Ban = seat2Preferred;
  }

  const remaining = categoryIds.filter((categoryId) => categoryId !== seat1Ban && categoryId !== seat2Ban);
  const remainingCategoryId = remaining[0]
    ?? categoryIds.find((categoryId) => categoryId !== seat1Ban)
    ?? categoryIds[0]
    ?? null;

  return {
    seat1Ban: seat1Ban ?? null,
    seat2Ban: seat2Ban ?? null,
    remainingCategoryId,
  };
}

async function finalizeHalftime(io: QuizballServer, matchId: string): Promise<void> {
  const lockKey = `lock:match:${matchId}:halftime`;
  const lock = await acquireLock(lockKey, 5000);
  if (!lock.acquired || !lock.token) return;

  try {
    const cache = await getMatchCacheOrRebuild(matchId);
    if (!cache || cache.status !== 'active') return;
    const state = cache.statePayload;
    if (state.phase !== 'HALFTIME') return;

    const halftimeResult = resolveHalftimeResult(state);
    state.halftime.bans.seat1 = halftimeResult.seat1Ban;
    state.halftime.bans.seat2 = halftimeResult.seat2Ban;
    state.halftime.deadlineAt = null;

    const halfTwoCategoryId = halftimeResult.remainingCategoryId ?? cache.categoryAId;
    cache.categoryBId = halfTwoCategoryId;
    fireAndForget('setMatchCategoryB(finalizeHalftime)', async () => {
      await matchesRepo.setMatchCategoryB(matchId, halfTwoCategoryId);
    });

    state.half = 2;
    state.phase = 'NORMAL_PLAY';
    state.possessionDiff = 0;
    state.kickOffSeat = nextSeat(state.kickOffSeat);
    state.lastAttack.attackerSeat = null;
    state.halftime.firstBanSeat = null;
    state.currentQuestion = null;
    state.normalQuestionsAnsweredInHalf = 0;
    bumpStateVersion(state);

    cache.currentQuestion = null;
    cache.answers = {};
    await setMatchCache(cache);
    fireAndForget('setMatchStatePayload(finalizeHalftime)', async () => {
      await matchesRepo.setMatchStatePayload(matchId, state, cache.currentQIndex);
    });
    await emitMatchState(io, matchId, state);

    await sendPossessionMatchQuestion(io, matchId, cache.currentQIndex, { cache });
  } finally {
    clearHalftimeTimer(matchId);
    await releaseLock(lockKey, lock.token);
  }
}

function scheduleFinalizeHalftime(io: QuizballServer, matchId: string, delayMs: number): void {
  clearHalftimeTimer(matchId);
  const timer = setTimeout(() => {
    void finalizeHalftime(io, matchId).catch((error) => {
      logger.error({ error, matchId }, 'Failed to finalize halftime after both bans');
    });
  }, delayMs);
  halftimeTimers.set(matchId, timer);
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

function schedulePossessionAiHalftimeBan(io: QuizballServer, matchId: string): void {
  clearHalftimeAiBanTimer(matchId);
  const delayMs = getHalftimeAiBanDelayMs();

  const timer = setTimeout(() => {
    void (async () => {
      const lockKey = `lock:match:${matchId}:halftime_ban`;
      const lock = await acquireLock(lockKey, 3000);
      if (!lock.acquired || !lock.token) return;

      try {
        const cache = await getMatchCacheOrRebuild(matchId);
        if (!cache || cache.status !== 'active') return;
        const state = cache.statePayload;
        if (state.phase !== 'HALFTIME') return;

        const aiUserId = await resolveAiUserIdForMatch(matchId);
        if (!aiUserId) return;
        const aiPlayer = getCachedPlayer(cache, aiUserId);
        if (!aiPlayer) return;

        const aiSeatKey = seatToBanKey(aiPlayer.seat);
        if (state.halftime.bans[aiSeatKey]) return;
        const turnSeat = getHalftimeTurnSeat(state);
        if (!turnSeat || aiPlayer.seat !== turnSeat) return;

        const options = state.halftime.categoryOptions.map((category) => category.id);
        if (options.length === 0) return;
        const otherSeatKey = aiSeatKey === 'seat1' ? 'seat2' : 'seat1';
        const otherBan = state.halftime.bans[otherSeatKey];
        const excluded = new Set<string>();
        if (otherBan) excluded.add(otherBan);
        const aiCategoryId = pickRandomCategoryId(options, excluded);
        if (!aiCategoryId) return;

        state.halftime.bans[aiSeatKey] = aiCategoryId;
        bumpStateVersion(state);

        await setMatchCache(cache);
        fireAndForget('setMatchStatePayload(halftimeAiBan)', async () => {
          await matchesRepo.setMatchStatePayload(matchId, state, cache.currentQIndex);
        });
        await emitMatchState(io, matchId, state);

        if (state.halftime.bans.seat1 && state.halftime.bans.seat2) {
          scheduleFinalizeHalftime(io, matchId, HALFTIME_POST_BAN_REVEAL_MS);
        }
      } finally {
        await releaseLock(lockKey, lock.token);
      }
    })().catch((error) => {
      logger.warn({ error, matchId }, 'Failed to process halftime AI ban');
    }).finally(() => {
      halftimeAiBanTimers.delete(matchId);
    });
  }, delayMs);

  halftimeAiBanTimers.set(matchId, timer);
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
  preloaded?: { cache: MatchCache }
): Promise<{ correctIndex: number } | null> {
  const cache = preloaded?.cache ?? await getMatchCacheOrRebuild(matchId);
  if (!cache || cache.status !== 'active') return null;
  const totalQuestions = cache.totalQuestions;
  const state = cache.statePayload;

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

  const categoryIds = categoryIdsForCurrentHalf(state, cache);
  const picked = await maybePickQuestionForState(matchId, state, categoryIds);
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
    phaseKind: runtimePhaseKind,
    phaseRound,
    shooterSeat,
    attackerSeat,
  });

  if (!inserted) {
    logger.warn({ matchId, qIndex, phaseKind: runtimePhaseKind }, 'Question row already exists for possession qIndex');
  }

  const payload = await matchesService.buildMatchQuestionPayload(matchId, qIndex);
  if (!payload) {
    logger.error({ matchId, qIndex }, 'Unable to build possession match question payload');
    return null;
  }

  const shownAt = new Date();
  const deadlineAt = new Date(Date.now() + QUESTION_TIME_MS);

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
    questionId: payload.question.id,
    correctIndex: payload.correctIndex,
    phaseKind: runtimePhaseKind,
    phaseRound,
    shooterSeat,
    attackerSeat,
    shownAt: shownAt.toISOString(),
    deadlineAt: deadlineAt.toISOString(),
    questionDTO: payload.question,
  };
  cache.answers = {};
  bumpStateVersion(state);

  await setMatchCache(cache);
  fireAndForget('setMatchStatePayload(sendQuestion)', async () => {
    await matchesRepo.setMatchStatePayload(matchId, state, qIndex);
  });
  fireAndForget('setQuestionTiming(sendQuestion)', async () => {
    await matchesRepo.setQuestionTiming(matchId, qIndex, shownAt, deadlineAt);
  });

  await emitMatchState(io, matchId, state);

  io.to(`match:${matchId}`).emit('match:question', {
    matchId,
    qIndex,
    total: totalQuestions,
    question: cache.currentQuestion.questionDTO,
    deadlineAt: deadlineAt.toISOString(),
    correctIndex: cache.currentQuestion.correctIndex,
    phaseKind: runtimePhaseKind,
    phaseRound,
    shooterSeat,
    attackerSeat,
  });

  scheduleQuestionTimeout(io, matchId, qIndex);
  void schedulePossessionAiAnswer(io, matchId, qIndex, {
    correctIndex: payload.correctIndex,
    optionCount: payload.question.options.length,
    phaseKind: runtimePhaseKind,
    phaseRound,
    shooterSeat,
  }).catch((error) => {
    logger.warn({ error, matchId, qIndex }, 'Failed to schedule possession AI answer');
  });

  return { correctIndex: payload.correctIndex };
}

function applyNormalResolution(
  state: PossessionStatePayload,
  seat1Points: number,
  seat2Points: number,
  seat1Correct: boolean,
  seat2Correct: boolean
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
    transitionAfterHalfBoundary(state);
    return result;
  }

  state.phase = 'NORMAL_PLAY';
  state.lastAttack.attackerSeat = null;
  return result;
}

function applyLastAttackResolution(
  state: PossessionStatePayload,
  seat1Points: number,
  seat2Points: number
): { delta: number; goalScoredBySeat: Seat | null } {
  const result = applyDeltaAndGoalCheck(state, seat1Points, seat2Points);
  state.lastAttack.attackerSeat = null;
  transitionAfterHalfBoundary(state);
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
  const lockKey = `lock:match:${matchId}:resolve`;
  const lock = await acquireLock(lockKey, 5000);
  if (!lock.acquired || !lock.token) return;

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
        timeMs: QUESTION_TIME_MS,
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
          seat2Answer?.is_correct ?? false
        )
        : applyLastAttackResolution(state, seat1Points, seat2Points);
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
      correctIndex: questionPayload.correctIndex,
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

    if (state.phase === 'HALFTIME') {
      scheduleHalftimeTimeout(io, matchId);
      schedulePossessionAiHalftimeBan(io, matchId);
      return;
    }

    if (state.phase === 'COMPLETED') {
      await completePossessionMatch(io, matchId, state);
      return;
    }

    const nextQuestionDelay = state.phase === 'PENALTY_SHOOTOUT'
      ? PENALTY_INTRO_DELAY_MS
      : ROUND_RESULT_DELAY_MS;

    setTimeout(() => {
      void sendPossessionMatchQuestion(io, matchId, nextIndex).catch((error) => {
        logger.error({ error, matchId, nextIndex }, 'Failed to send next possession question');
      });
    }, nextQuestionDelay);
  } finally {
    await releaseLock(lockKey, lock.token);
    clearQuestionTimer(matchId, qIndex);
    clearAiAnswerTimer(matchId, qIndex);
  }
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
  const [players, questionPayload, existing, questionTiming] = await Promise.all([
    matchesRepo.listMatchPlayers(matchId),
    matchesService.buildMatchQuestionPayload(matchId, qIndex),
    matchesRepo.getAnswerForUser(matchId, qIndex, socket.data.user.id),
    matchesRepo.getMatchQuestionTiming(matchId, qIndex),
  ]);

  const mySeat = getSeatFromUserId(players, socket.data.user.id);
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

  const authoritativeTimeMs = questionTiming
    ? toAuthoritativeTimeMs(questionTiming, Date.now(), timeMs)
    : clamp(timeMs, 0, QUESTION_TIME_MS);
  const clientTimeMs = clamp(timeMs, 0, QUESTION_TIME_MS);
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

  const isCorrect = selectedIndex !== null && selectedIndex === questionPayload.correctIndex;
  const pointsEarned = calculatePoints(isCorrect, clientTimeMs, QUESTION_TIME_MS);

  await matchesRepo.insertMatchAnswer({
    matchId,
    qIndex,
    userId: socket.data.user.id,
    selectedIndex,
    isCorrect,
    timeMs: clientTimeMs,
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
      for (const userId of expectedUserIds) {
        if (cache.answers[userId]) continue;
        const backfill: CachedAnswer = {
          userId,
          selectedIndex: null,
          isCorrect: false,
          timeMs: QUESTION_TIME_MS,
          pointsEarned: 0,
          phaseKind: question.phaseKind,
          phaseRound: question.phaseRound,
          shooterSeat: question.shooterSeat,
          answeredAt: new Date().toISOString(),
        };
        cache.answers[userId] = backfill;
        fireAndForget('insertMatchAnswerIfMissing(timeout)', async () => {
          await matchesRepo.insertMatchAnswerIfMissing({
            matchId,
            qIndex,
            userId,
            selectedIndex: null,
            isCorrect: false,
            timeMs: QUESTION_TIME_MS,
            pointsEarned: 0,
            phaseKind: question.phaseKind,
            phaseRound: question.phaseRound,
            shooterSeat: question.shooterSeat,
          });
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
          seat2Answer?.isCorrect ?? false
        )
        : applyLastAttackResolution(state, seat1Points, seat2Points);
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
      correctIndex: question.correctIndex,
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

    const nextQuestionDelay = state.phase === 'PENALTY_SHOOTOUT'
      ? PENALTY_INTRO_DELAY_MS
      : ROUND_RESULT_DELAY_MS;

    setTimeout(() => {
      void sendPossessionMatchQuestion(io, matchId, nextIndex).catch((error) => {
        logger.error({ error, matchId, nextIndex }, 'Failed to send next possession question');
      });
    }, nextQuestionDelay);
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

    const authoritativeTimeMs = toAuthoritativeTimeMsFromCache(
      {
        shownAt: question.shownAt,
        deadlineAt: question.deadlineAt,
      },
      Date.now(),
      timeMs
    );
    const clientTimeMs = clamp(timeMs, 0, QUESTION_TIME_MS);
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
    const isCorrect = selectedIndex !== null && selectedIndex === question.correctIndex;
    const pointsEarned = calculatePoints(isCorrect, clientTimeMs, QUESTION_TIME_MS);

    const answer: CachedAnswer = {
      userId: socket.data.user.id,
      selectedIndex,
      isCorrect,
      timeMs: clientTimeMs,
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
      answerTimeMs: clientTimeMs,
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
    selectedIndex,
    isCorrect: committed.isCorrect,
    correctIndex: committed.question.correctIndex,
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

    const optionCount = cache.currentQuestion.questionDTO.options.length;
    const wrongIndices = Array.from({ length: optionCount }, (_, index) => index).filter(
      (index) => index !== cache.currentQuestion!.correctIndex
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
  aiUserIdByMatch.delete(matchId);
  aiCorrectnessForMatch.delete(matchId);
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
  effectiveAnswerTimeMs,
  applyDeltaAndGoalCheck,
  applyNormalResolution,
  applyLastAttackResolution,
  resolveHalftimeResult,
  penaltyWinnerSeat,
  decideWinner,
};
