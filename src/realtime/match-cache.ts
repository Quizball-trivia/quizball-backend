import { logger } from '../core/logger.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import {
  createInitialPossessionState,
  POSSESSION_QUESTIONS_PER_HALF,
  type PossessionStatePayload,
} from '../modules/matches/matches.service.js';
import { matchesService } from '../modules/matches/matches.service.js';
import { getRedisClient } from './redis.js';
import { clamp } from './scoring.js';
import type { GameQuestionDTO, MatchPhaseKind, MatchMode } from './socket.types.js';

const MATCH_CACHE_TTL_SEC = 60 * 60;

export type CachedSeat = 1 | 2;

export interface CachedPlayer {
  userId: string;
  seat: CachedSeat;
  totalPoints: number;
  correctAnswers: number;
  goals: number;
  penaltyGoals: number;
  avgTimeMs: number | null;
}

export interface CachedAnswer {
  userId: string;
  selectedIndex: number | null;
  isCorrect: boolean;
  timeMs: number;
  pointsEarned: number;
  phaseKind: MatchPhaseKind;
  phaseRound: number | null;
  shooterSeat: CachedSeat | null;
  answeredAt: string | null;
}

export interface CachedQuestion {
  qIndex: number;
  questionId: string;
  correctIndex: number;
  phaseKind: MatchPhaseKind;
  phaseRound: number | null;
  shooterSeat: CachedSeat | null;
  attackerSeat: CachedSeat | null;
  shownAt: string | null;
  deadlineAt: string | null;
  questionDTO: GameQuestionDTO;
}

export interface MatchCache {
  matchId: string;
  status: 'active' | 'completed' | 'abandoned';
  mode: MatchMode;
  totalQuestions: number;
  categoryAId: string;
  categoryBId: string | null;
  startedAt: string;
  players: CachedPlayer[];
  currentQIndex: number;
  statePayload: PossessionStatePayload;
  currentQuestion: CachedQuestion | null;
  answers: Record<string, CachedAnswer>;
}

export function matchCacheKey(matchId: string): string {
  return `match:cache:${matchId}`;
}

function asSeat(value: number | null | undefined): CachedSeat | null {
  if (value === 1 || value === 2) return value;
  return null;
}

const RUNTIME_PHASE_KINDS = new Set(['normal', 'last_attack', 'penalty'] as const);
function asRuntimePhaseKind(value: unknown): 'normal' | 'last_attack' | 'penalty' {
  if (typeof value === 'string' && RUNTIME_PHASE_KINDS.has(value as 'normal' | 'last_attack' | 'penalty')) {
    return value as 'normal' | 'last_attack' | 'penalty';
  }
  return 'normal';
}

function sanitizePossessionState(raw: unknown): PossessionStatePayload {
  const fallback = createInitialPossessionState();
  if (!raw || typeof raw !== 'object') return fallback;
  const candidate = raw as Partial<PossessionStatePayload>;

  return {
    ...fallback,
    ...candidate,
    goals: {
      seat1: Math.max(0, Number(candidate.goals?.seat1 ?? fallback.goals.seat1)),
      seat2: Math.max(0, Number(candidate.goals?.seat2 ?? fallback.goals.seat2)),
    },
    penaltyGoals: {
      seat1: Math.max(0, Number(candidate.penaltyGoals?.seat1 ?? fallback.penaltyGoals.seat1)),
      seat2: Math.max(0, Number(candidate.penaltyGoals?.seat2 ?? fallback.penaltyGoals.seat2)),
    },
    possessionDiff: clamp(Number(candidate.possessionDiff ?? fallback.possessionDiff), -100, 100),
    kickOffSeat: asSeat(candidate.kickOffSeat) ?? fallback.kickOffSeat,
    normalQuestionsPerHalf: POSSESSION_QUESTIONS_PER_HALF,
    normalQuestionsAnsweredInHalf: Math.max(0, Number(candidate.normalQuestionsAnsweredInHalf ?? 0)),
    normalQuestionsAnsweredTotal: Math.max(0, Number(candidate.normalQuestionsAnsweredTotal ?? 0)),
    halftime: {
      deadlineAt: candidate.halftime?.deadlineAt ?? null,
      categoryOptions: Array.isArray(candidate.halftime?.categoryOptions)
        ? candidate.halftime?.categoryOptions.reduce<Array<{ id: string; name: string; icon: string | null }>>((acc, category) => {
          if (!category || typeof category !== 'object') return acc;
          if (typeof category.id !== 'string' || typeof category.name !== 'string') return acc;
          acc.push({
            id: category.id,
            name: category.name,
            icon: typeof category.icon === 'string' ? category.icon : null,
          });
          return acc;
        }, [])
        : [],
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
        phaseKind: asRuntimePhaseKind(candidate.currentQuestion.phaseKind),
        phaseRound: Number(candidate.currentQuestion.phaseRound ?? 0),
        shooterSeat: asSeat(candidate.currentQuestion.shooterSeat),
        attackerSeat: asSeat(candidate.currentQuestion.attackerSeat),
      }
      : null,
    winnerDecisionMethod: candidate.winnerDecisionMethod ?? null,
  };
}

function toCachedAnswer(rows: {
  user_id: string;
  selected_index: number | null;
  is_correct: boolean;
  time_ms: number;
  points_earned: number;
  phase_kind: MatchPhaseKind;
  phase_round: number | null;
  shooter_seat: number | null;
  answered_at: string;
}[]): Record<string, CachedAnswer> {
  const answers: Record<string, CachedAnswer> = {};
  for (const row of rows) {
    answers[row.user_id] = {
      userId: row.user_id,
      selectedIndex: row.selected_index,
      isCorrect: row.is_correct,
      timeMs: row.time_ms,
      pointsEarned: row.points_earned,
      phaseKind: row.phase_kind,
      phaseRound: row.phase_round,
      shooterSeat: asSeat(row.shooter_seat),
      answeredAt: row.answered_at,
    };
  }
  return answers;
}

export function buildInitialCache(params: {
  match: {
    id: string;
    status: 'active' | 'completed' | 'abandoned';
    mode: MatchMode;
    total_questions: number;
    category_a_id: string;
    category_b_id: string | null;
    started_at: string;
    current_q_index: number;
    state_payload: unknown;
  };
  players: Array<{
    user_id: string;
    seat: number;
    total_points: number;
    correct_answers: number;
    goals: number;
    penalty_goals: number;
    avg_time_ms: number | null;
  }>;
  state?: PossessionStatePayload;
}): MatchCache {
  const statePayload = params.state ?? sanitizePossessionState(params.match.state_payload);
  const players = params.players.map((player) => ({
    userId: player.user_id,
    seat: (player.seat === 2 ? 2 : 1) as CachedSeat,
    totalPoints: player.total_points,
    correctAnswers: player.correct_answers,
    goals: player.goals,
    penaltyGoals: player.penalty_goals,
    avgTimeMs: player.avg_time_ms,
  }));

  return {
    matchId: params.match.id,
    status: params.match.status,
    mode: params.match.mode,
    totalQuestions: params.match.total_questions,
    categoryAId: params.match.category_a_id,
    categoryBId: params.match.category_b_id,
    startedAt: params.match.started_at,
    players,
    currentQIndex: params.match.current_q_index,
    statePayload,
    currentQuestion: null,
    answers: {},
  };
}

export async function getMatchCache(matchId: string): Promise<MatchCache | null> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return null;

  const raw = await redis.get(matchCacheKey(matchId));
  if (!raw) return null;

  try {
    return JSON.parse(raw) as MatchCache;
  } catch (error) {
    logger.warn({ error, matchId }, 'Failed to parse match cache, deleting key');
    await redis.del(matchCacheKey(matchId));
    return null;
  }
}

export async function setMatchCache(cache: MatchCache): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return;
  try {
    await redis.set(matchCacheKey(cache.matchId), JSON.stringify(cache), {
      EX: MATCH_CACHE_TTL_SEC,
    });
  } catch (error) {
    logger.error({ error, matchId: cache.matchId }, 'Failed to write match cache');
  }
}

export async function deleteMatchCache(matchId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return;
  await redis.del(matchCacheKey(matchId));
}

export async function rebuildCacheFromDB(matchId: string): Promise<MatchCache | null> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match) return null;
  const players = await matchesRepo.listMatchPlayers(matchId);
  const state = sanitizePossessionState(match.state_payload);

  const cache = buildInitialCache({
    match,
    players,
    state,
  });

  const currentQuestionIndex = state.currentQuestion?.qIndex ?? match.current_q_index;
  const questionPayload = await matchesService.buildMatchQuestionPayload(matchId, currentQuestionIndex);
  const timing = questionPayload
    ? await matchesRepo.getMatchQuestionTiming(matchId, currentQuestionIndex)
    : null;

  if (questionPayload) {
    cache.currentQuestion = {
      qIndex: currentQuestionIndex,
      questionId: questionPayload.question.id,
      correctIndex: questionPayload.correctIndex,
      phaseKind: questionPayload.phaseKind,
      phaseRound: questionPayload.phaseRound,
      shooterSeat: questionPayload.shooterSeat,
      attackerSeat: questionPayload.attackerSeat,
      shownAt: timing?.shown_at ?? null,
      deadlineAt: timing?.deadline_at ?? null,
      questionDTO: questionPayload.question,
    };
    const answers = await matchesRepo.listAnswersForQuestion(matchId, currentQuestionIndex);
    cache.answers = toCachedAnswer(answers);
  } else {
    cache.currentQuestion = null;
    cache.answers = {};
  }

  return cache;
}

export async function getMatchCacheOrRebuild(matchId: string): Promise<MatchCache | null> {
  const cached = await getMatchCache(matchId);
  if (cached) return cached;

  const rebuilt = await rebuildCacheFromDB(matchId);
  if (!rebuilt) return null;

  await setMatchCache(rebuilt);
  return rebuilt;
}

export function getCachedPlayer(cache: MatchCache, userId: string): CachedPlayer | null {
  return cache.players.find((player) => player.userId === userId) ?? null;
}

export function getCachedPlayerBySeat(cache: MatchCache, seat: CachedSeat): CachedPlayer | null {
  return cache.players.find((player) => player.seat === seat) ?? null;
}

export function hasUserAnswered(cache: MatchCache, userId: string): boolean {
  return Boolean(cache.answers[userId]);
}

export function answerCount(cache: MatchCache): number {
  return Object.keys(cache.answers).length;
}

export function getExpectedUserIds(cache: MatchCache): string[] {
  const question = cache.currentQuestion;
  if (!question) {
    return cache.players.map((player) => player.userId);
  }

  if (question.phaseKind === 'penalty' && question.shooterSeat) {
    const shooter = getCachedPlayerBySeat(cache, question.shooterSeat)?.userId ?? null;
    const keeperSeat: CachedSeat = question.shooterSeat === 1 ? 2 : 1;
    const keeper = getCachedPlayerBySeat(cache, keeperSeat)?.userId ?? null;
    return [shooter, keeper].filter((value): value is string => Boolean(value));
  }

  return cache.players.map((player) => player.userId);
}
