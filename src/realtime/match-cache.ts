import { logger } from '../core/logger.js';
import { appMetrics } from '../core/metrics.js';
import { withSpan } from '../core/tracing.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import {
  createInitialPossessionState,
  matchesService,
  POSSESSION_QUESTIONS_PER_HALF,
  type MatchQuestionEvaluation,
  type PossessionStatePayload,
} from '../modules/matches/matches.service.js';
import { getRedisClient } from './redis.js';
import { acquireLock, releaseLock } from './locks.js';
import { countdownPlayerKey } from './match-keys.js';
import { getCachedMultipleChoiceCorrectIndex, normalizeMatchQuestionPayload } from './question-compat.js';
import { clamp } from './scoring.js';
import type { GameQuestionDTO, MatchPhaseKind, MatchMode, MatchQuestionKind, MatchRoundReveal } from './socket.types.js';

const MATCH_CACHE_TTL_SEC = 60 * 60;
const MATCH_CACHE_REBUILD_LOCK_TTL_MS = 5000;
const MATCH_CACHE_REBUILD_RETRY_ATTEMPTS = 3;
const MATCH_CACHE_REBUILD_RETRY_DELAY_MS = 50;

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
  questionKind: MatchQuestionKind;
  selectedIndex: number | null;
  isCorrect: boolean;
  timeMs: number;
  pointsEarned: number;
  phaseKind: MatchPhaseKind;
  phaseRound: number | null;
  shooterSeat: CachedSeat | null;
  answeredAt: string | null;
  foundCount?: number;
  foundAnswerIds?: string[];
  submittedOrderIds?: string[];
  clueIndex?: number | null;
}

export interface CachedQuestion {
  qIndex: number;
  kind: MatchQuestionKind;
  questionId: string;
  correctIndex: number;
  phaseKind: MatchPhaseKind;
  phaseRound: number | null;
  shooterSeat: CachedSeat | null;
  attackerSeat: CachedSeat | null;
  shownAt: string | null;
  deadlineAt: string | null;
  questionDTO: GameQuestionDTO;
  evaluation: MatchQuestionEvaluation;
  reveal: MatchRoundReveal;
}

export interface CachedChanceCardUse {
  userId: string;
  qIndex: number;
  clientActionId: string;
  eliminatedIndices: number[];
  remainingQuantity: number;
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
  chanceCardUses: Record<string, CachedChanceCardUse>;
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

function sanitizePossessionState(
  raw: unknown,
  mode: MatchMode = 'friendly'
): PossessionStatePayload {
  const explicitVariant =
    raw && typeof raw === 'object'
      ? (raw as Partial<PossessionStatePayload>).variant
      : undefined;
  const fallbackVariant = explicitVariant === 'ranked_sim'
    ? 'ranked_sim'
    : mode === 'ranked'
      ? 'ranked_sim'
      : 'friendly_possession';
  const fallback = createInitialPossessionState(fallbackVariant);
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
        ? candidate.halftime?.categoryOptions.reduce<Array<{ id: string; name: string; icon: string | null; imageUrl: string | null }>>((acc, category) => {
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
      questionKind: 'multipleChoice',
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
  const statePayload = params.state ?? sanitizePossessionState(params.match.state_payload, params.match.mode);
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
    chanceCardUses: {},
  };
}

export async function getMatchCache(matchId: string): Promise<MatchCache | null> {
  return withSpan('match.cache.get', {
    'quizball.match_id': matchId,
  }, async (span) => {
    const redis = getRedisClient();
    if (!redis || !redis.isOpen) {
      span.setAttribute('quizball.cache_backend_available', false);
      return null;
    }

    const raw = await redis.get(matchCacheKey(matchId));
    if (!raw) {
      span.setAttribute('quizball.cache_hit', false);
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<MatchCache>;
      const chanceCardUses =
        parsed.chanceCardUses &&
        typeof parsed.chanceCardUses === 'object' &&
        !Array.isArray(parsed.chanceCardUses)
          ? parsed.chanceCardUses
          : {};
      span.setAttribute('quizball.cache_hit', true);
      return {
        ...(parsed as MatchCache),
        chanceCardUses,
      };
    } catch (error) {
      span.setAttribute('quizball.cache_parse_failed', true);
      logger.warn({ error, matchId }, 'Failed to parse match cache, deleting key');
      await redis.del(matchCacheKey(matchId));
      return null;
    }
  });
}

export async function setMatchCache(cache: MatchCache): Promise<void> {
  await withSpan('match.cache.set', {
    'quizball.match_id': cache.matchId,
    'quizball.current_q_index': cache.currentQIndex,
  }, async (span) => {
    const redis = getRedisClient();
    if (!redis || !redis.isOpen) {
      span.setAttribute('quizball.cache_backend_available', false);
      return;
    }
    try {
      await redis.set(matchCacheKey(cache.matchId), JSON.stringify(cache), {
        EX: MATCH_CACHE_TTL_SEC,
      });
    } catch (error) {
      span.setAttribute('quizball.cache_write_failed', true);
      logger.error({ error, matchId: cache.matchId }, 'Failed to write match cache');
    }
  });
}

export async function deleteMatchCache(matchId: string): Promise<void> {
  await withSpan('match.cache.delete', {
    'quizball.match_id': matchId,
  }, async (span) => {
    const redis = getRedisClient();
    if (!redis || !redis.isOpen) {
      span.setAttribute('quizball.cache_backend_available', false);
      return;
    }
    await redis.del(matchCacheKey(matchId));
  });
}

export async function rebuildCacheFromDB(matchId: string): Promise<MatchCache | null> {
  return withSpan('match.cache.rebuild', {
    'quizball.match_id': matchId,
  }, async (span) => {
    const startedAt = Date.now();
    const match = await matchesRepo.getMatch(matchId);
    if (!match) {
      span.setAttribute('quizball.match_found', false);
      return null;
    }
    const players = await matchesRepo.listMatchPlayers(matchId);
    const state = sanitizePossessionState(match.state_payload, match.mode);

    const cache = buildInitialCache({
      match,
      players,
      state,
    });

    const currentQuestionIndex = state.currentQuestion?.qIndex ?? match.current_q_index;
    span.setAttribute('quizball.current_q_index', currentQuestionIndex);
    const rawQuestionPayload = await matchesService.buildMatchQuestionPayload(matchId, currentQuestionIndex);
    const questionPayload = normalizeMatchQuestionPayload(rawQuestionPayload);
    const timing = questionPayload
      ? await matchesRepo.getMatchQuestionTiming(matchId, currentQuestionIndex)
      : null;

    if (questionPayload) {
      const correctIndex = getCachedMultipleChoiceCorrectIndex({
        kind: questionPayload.question.kind,
        evaluation: questionPayload.evaluation,
        questionDTO: questionPayload.question,
      }) ?? 0;
      cache.currentQuestion = {
        qIndex: currentQuestionIndex,
        kind: questionPayload.question.kind,
        questionId: questionPayload.question.id,
        correctIndex,
        phaseKind: questionPayload.phaseKind,
        phaseRound: questionPayload.phaseRound,
        shooterSeat: questionPayload.shooterSeat,
        attackerSeat: questionPayload.attackerSeat,
        shownAt: timing?.shown_at ?? null,
        deadlineAt: timing?.deadline_at ?? null,
        questionDTO: questionPayload.question,
        evaluation: questionPayload.evaluation,
        reveal: questionPayload.reveal,
      };
      const answers = await matchesRepo.listAnswersForQuestion(matchId, currentQuestionIndex);
      cache.answers = toCachedAnswer(answers);
    } else {
      cache.currentQuestion = null;
      cache.answers = {};
    }

    appMetrics.cacheRebuilds.add(1, { match_mode: match.mode });
    appMetrics.questionGenerationDuration.record(Date.now() - startedAt, {
      match_mode: match.mode,
      source: 'cache_rebuild',
    });
    return cache;
  });
}

export async function getMatchCacheOrRebuild(matchId: string): Promise<MatchCache | null> {
  return withSpan('match.cache.get_or_rebuild', {
    'quizball.match_id': matchId,
  }, async (span) => {
    const cached = await getMatchCache(matchId);
    if (cached) {
      span.setAttribute('quizball.cache_source', 'redis');
      return cached;
    }

    const rebuildLockKey = `match:cache:rebuild:${matchId}`;

    for (let attempt = 0; attempt < MATCH_CACHE_REBUILD_RETRY_ATTEMPTS; attempt += 1) {
      const lock = await acquireLock(rebuildLockKey, MATCH_CACHE_REBUILD_LOCK_TTL_MS);
      if (!lock.acquired || !lock.token) {
        const retryCached = await getMatchCache(matchId);
        if (retryCached) {
          span.setAttribute('quizball.cache_source', 'redis_retry');
          return retryCached;
        }

        if (attempt < MATCH_CACHE_REBUILD_RETRY_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, MATCH_CACHE_REBUILD_RETRY_DELAY_MS));
        }
        continue;
      }

      try {
        const cachedAfterLock = await getMatchCache(matchId);
        if (cachedAfterLock) {
          span.setAttribute('quizball.cache_source', 'redis_retry');
          return cachedAfterLock;
        }

        const rebuilt = await rebuildCacheFromDB(matchId);
        if (!rebuilt) {
          span.setAttribute('quizball.cache_source', 'missing');
          return null;
        }

        span.setAttribute('quizball.cache_source', 'db_rebuild');
        await setMatchCache(rebuilt);
        return rebuilt;
      } finally {
        await releaseLock(rebuildLockKey, lock.token);
      }
    }

    const finalRetryCached = await getMatchCache(matchId);
    if (finalRetryCached) {
      span.setAttribute('quizball.cache_source', 'redis_retry');
      return finalRetryCached;
    }

    span.setAttribute('quizball.cache_source', 'missing');
    return null;
  });
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

// ── Per-player countdown Redis state ──
// Each player's found answer group IDs are stored in a separate Redis Set,
// avoiding lock contention between players during concurrent guessing.

const COUNTDOWN_PLAYER_TTL_SEC = 120; // Auto-expire after 2 minutes (safety net)

/**
 * Lua script: atomically check if an answer group ID is already in the set,
 * add it if not, refresh TTL, and return [wasAdded, count].
 * wasAdded: 0 = duplicate, 1 = newly added.
 */
const COUNTDOWN_ADD_FOUND_SCRIPT = `
  local added = redis.call("SADD", KEYS[1], ARGV[1])
  redis.call("EXPIRE", KEYS[1], ARGV[2])
  local count = redis.call("SCARD", KEYS[1])
  return { added, count }
`;

export interface CountdownAddResult {
  /** Whether the answer group was newly added (not a duplicate). */
  added: boolean;
  /** Total number of found answer groups after this operation. */
  foundCount: number;
}

/**
 * Atomically add a found answer group ID for a player's countdown round.
 * Returns { added: false, foundCount } if the ID was already present.
 */
export async function countdownAddFound(
  matchId: string,
  userId: string,
  answerGroupId: string
): Promise<CountdownAddResult> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) {
    throw new Error('Redis unavailable for countdown state');
  }
  const key = countdownPlayerKey(matchId, userId);
  const [wasAdded, count] = await redis.eval(COUNTDOWN_ADD_FOUND_SCRIPT, {
    keys: [key],
    arguments: [answerGroupId, String(COUNTDOWN_PLAYER_TTL_SEC)],
  }) as [number, number];

  return { added: wasAdded === 1, foundCount: count };
}

/**
 * Get all found answer group IDs for a player in the current countdown round.
 */
export async function countdownGetFound(
  matchId: string,
  userId: string
): Promise<string[]> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return [];
  const key = countdownPlayerKey(matchId, userId);
  return redis.sMembers(key);
}

/**
 * Delete per-player countdown keys after round resolution.
 */
export async function deleteCountdownPlayerKeys(
  matchId: string,
  userIds: string[]
): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return;
  const keys = userIds.map((uid) => countdownPlayerKey(matchId, uid));
  if (keys.length > 0) {
    await redis.del(keys);
  }
}
