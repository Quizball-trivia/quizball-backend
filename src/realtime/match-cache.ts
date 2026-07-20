import { logger } from '../core/logger.js';
import { appMetrics } from '../core/metrics.js';
import { withSpan } from '../core/tracing.js';
import { ExternalServiceError } from '../core/errors.js';
import type { I18nField, Json } from '../db/types.js';
import { matchAnswersRepo } from '../modules/matches/match-answers.repo.js';
import { matchPlayersRepo } from '../modules/matches/match-players.repo.js';
import { matchQuestionsRepo } from '../modules/matches/match-questions.repo.js';
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
import { normalizeI18nName } from './match-utils.js';
import type { DraftCategory, GameQuestionDTO, MatchPhaseKind, MatchMode, MatchQuestionKind, MatchRoundReveal } from './socket.types.js';

const MATCH_CACHE_TTL_SEC = 60 * 60;
const MATCH_CACHE_REBUILD_LOCK_TTL_MS = 5000;
const MATCH_CACHE_REBUILD_RETRY_ATTEMPTS = 3;
const MATCH_CACHE_REBUILD_RETRY_DELAY_MS = 50;

export type CachedSeat = 1 | 2;

export interface CachedPlayer {
  userId: string;
  // Possession uses seats 1/2, but party-quiz lobbies support up to six
  // players. Keeping the durable seat avoids collapsing players 3..6 onto 1.
  seat: number;
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

const VALID_QUESTION_KINDS: ReadonlySet<MatchQuestionKind> = new Set([
  'multipleChoice',
  'countdown',
  'putInOrder',
  'clues',
]);

function asQuestionKind(value: unknown): MatchQuestionKind {
  return typeof value === 'string' && (VALID_QUESTION_KINDS as ReadonlySet<string>).has(value)
    ? (value as MatchQuestionKind)
    : 'multipleChoice';
}

function stringArrayFromPayload(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function numberFromPayload(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizePenaltyAttempts(params: {
  attempts: unknown;
  goals: { seat1: number; seat2: number };
  kicksTaken: { seat1: number; seat2: number };
}): { seat1: Array<'goal' | 'miss'>; seat2: Array<'goal' | 'miss'> } {
  const fromRaw = (value: unknown, goals: number, kicksTaken: number): Array<'goal' | 'miss'> => {
    const total = Math.max(0, kicksTaken);
    // Canonical default: `goals` goals followed by misses, exactly `kicksTaken` long.
    const result: Array<'goal' | 'miss'> = [
      ...Array.from({ length: Math.min(total, Math.max(0, goals)) }, () => 'goal' as const),
      ...Array.from({ length: Math.max(0, total - Math.max(0, goals)) }, () => 'miss' as const),
    ];
    // Overwrite the prefix with any real per-kick outcomes we have, but NEVER
    // change the length — a rebuilt cache must keep attempts.length === kicksTaken,
    // otherwise the penalty UI sees contradictory state (slice() can't pad).
    if (Array.isArray(value)) {
      const sanitized = value.filter((entry): entry is 'goal' | 'miss' => entry === 'goal' || entry === 'miss');
      for (let i = 0; i < Math.min(sanitized.length, total); i += 1) {
        result[i] = sanitized[i];
      }
    }
    return result;
  };

  const raw = params.attempts && typeof params.attempts === 'object'
    ? params.attempts as { seat1?: unknown; seat2?: unknown }
    : {};
  return {
    seat1: fromRaw(raw.seat1, params.goals.seat1, params.kicksTaken.seat1),
    seat2: fromRaw(raw.seat2, params.goals.seat2, params.kicksTaken.seat2),
  };
}

export function buildAnswerPayload(answer: Pick<CachedAnswer,
  'questionKind' | 'foundCount' | 'foundAnswerIds' | 'submittedOrderIds' | 'clueIndex'
>): Json {
  return {
    questionKind: answer.questionKind,
    foundCount: answer.foundCount ?? null,
    foundAnswerIds: answer.foundAnswerIds ?? null,
    submittedOrderIds: answer.submittedOrderIds ?? null,
    clueIndex: answer.clueIndex ?? null,
  };
}

export interface CachedClueReveal {
  qIndex: number;
  revealCount: number;
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

export interface CachedRevealAck {
  qIndex: number;
  revealAtMs: number;
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
  revealAcks?: Record<string, CachedRevealAck>;
  clueReveals?: Record<string, CachedClueReveal>;
}

export function matchCacheKey(matchId: string): string {
  return `match:cache:${matchId}`;
}

/**
 * Per-question answer OVERLAY hash (perf, db-optimize.md #7 / perf-audit #7).
 *
 * Committing an answer used to re-serialize and SET the ENTIRE match cache
 * blob (state + full question DTO + players) — multiple KB of JSON.stringify
 * and Redis bandwidth on the hottest path in the game. Instead, answer
 * commits now write ONE small hash entry here and skip the blob write.
 *
 * Contract: the blob remains the source of truth for everything else; reads
 * merge this overlay on top (answers + the committing player's running
 * totals). The key is namespaced by qIndex, so advancing the round naturally
 * orphans the previous overlay (reaped by TTL) with no clear-site changes.
 */
export function matchAnswersOverlayKey(matchId: string, qIndex: number): string {
  return `match:cache:answers:${matchId}:${qIndex}`;
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
  const penaltyGoals = {
    seat1: Math.max(0, Number(candidate.penaltyGoals?.seat1 ?? fallback.penaltyGoals.seat1)),
    seat2: Math.max(0, Number(candidate.penaltyGoals?.seat2 ?? fallback.penaltyGoals.seat2)),
  };
  const penaltyKicksTaken = {
    seat1: Math.max(0, Number(candidate.penalty?.kicksTaken?.seat1 ?? 0)),
    seat2: Math.max(0, Number(candidate.penalty?.kicksTaken?.seat2 ?? 0)),
  };

  return {
    ...fallback,
    ...candidate,
    goals: {
      seat1: Math.max(0, Number(candidate.goals?.seat1 ?? fallback.goals.seat1)),
      seat2: Math.max(0, Number(candidate.goals?.seat2 ?? fallback.goals.seat2)),
    },
    penaltyGoals,
    possessionDiff: clamp(Number(candidate.possessionDiff ?? fallback.possessionDiff), -100, 100),
    kickOffSeat: asSeat(candidate.kickOffSeat) ?? fallback.kickOffSeat,
    normalQuestionsPerHalf: POSSESSION_QUESTIONS_PER_HALF,
    normalQuestionsAnsweredInHalf: Math.max(0, Number(candidate.normalQuestionsAnsweredInHalf ?? 0)),
    normalQuestionsAnsweredTotal: Math.max(0, Number(candidate.normalQuestionsAnsweredTotal ?? 0)),
    halftime: {
      deadlineAt: candidate.halftime?.deadlineAt ?? null,
      uiReadyAt: typeof candidate.halftime?.uiReadyAt === 'string' ? candidate.halftime.uiReadyAt : null,
      readyDeferCount: typeof candidate.halftime?.readyDeferCount === 'number'
        ? Math.max(0, Math.trunc(candidate.halftime.readyDeferCount))
        : 0,
      categoryOptions: Array.isArray(candidate.halftime?.categoryOptions)
        ? candidate.halftime?.categoryOptions.reduce<Array<{ id: string; name: I18nField; icon: string | null; imageUrl: string | null }>>((acc, category) => {
          if (!category || typeof category !== 'object') return acc;
          // `name` is normally the full i18n object; tolerate the legacy string
          // shape persisted by matches drafted before the i18n change.
          const normalizedName = normalizeI18nName(category.name);
          if (typeof category.id !== 'string' || normalizedName === null) return acc;
          const legacyImageUrl = (category as { image_url?: unknown }).image_url;
          acc.push({
            id: category.id,
            name: normalizedName,
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
      // Preserve the ban purpose across cache rebuild — a rebuild mid penalty-ban
      // must NOT default back to 'second_half' or finalize would exit to normal play.
      purpose: candidate.halftime?.purpose === 'penalty' ? 'penalty' : 'second_half',
    },
    lastAttack: {
      attackerSeat: asSeat(candidate.lastAttack?.attackerSeat),
    },
    penalty: {
      round: Math.max(0, Number(candidate.penalty?.round ?? 0)),
      shooterSeat: asSeat(candidate.penalty?.shooterSeat) ?? 1,
      suddenDeath: Boolean(candidate.penalty?.suddenDeath),
      kicksTaken: penaltyKicksTaken,
      attempts: normalizePenaltyAttempts({
        attempts: candidate.penalty?.attempts,
        goals: penaltyGoals,
        kicksTaken: penaltyKicksTaken,
      }),
    },
    penaltyCategoryId: typeof candidate.penaltyCategoryId === 'string' ? candidate.penaltyCategoryId : null,
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
  answer_payload: Json | null;
  answered_at: string;
}[]): Record<string, CachedAnswer> {
  const answers: Record<string, CachedAnswer> = {};
  for (const row of rows) {
    const payload = row.answer_payload && typeof row.answer_payload === 'object' && !Array.isArray(row.answer_payload)
      ? row.answer_payload as Record<string, unknown>
      : {};
    const questionKind = asQuestionKind(payload.questionKind);
    answers[row.user_id] = {
      userId: row.user_id,
      questionKind,
      selectedIndex: row.selected_index,
      isCorrect: row.is_correct,
      timeMs: row.time_ms,
      pointsEarned: row.points_earned,
      phaseKind: row.phase_kind,
      phaseRound: row.phase_round,
      shooterSeat: asSeat(row.shooter_seat),
      answeredAt: row.answered_at,
      foundCount: numberFromPayload(payload.foundCount),
      foundAnswerIds: stringArrayFromPayload(payload.foundAnswerIds),
      submittedOrderIds: stringArrayFromPayload(payload.submittedOrderIds),
      clueIndex: typeof payload.clueIndex === 'number' ? payload.clueIndex : null,
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
    seat: Number.isInteger(player.seat) && player.seat > 0 ? player.seat : 1,
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
    revealAcks: {},
    clueReveals: {},
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
      const cached = parsed as MatchCache;
      // Backfill halftime.uiReadyAt on cache entries written before the field
      // existed — otherwise downstream code sees `undefined` instead of `null`.
      if (cached.statePayload && 'halftime' in cached.statePayload && cached.statePayload.halftime) {
        const ht = cached.statePayload.halftime as { uiReadyAt?: unknown; categoryOptions?: unknown };
        ht.uiReadyAt = typeof ht.uiReadyAt === 'string' ? ht.uiReadyAt : null;
        // Normalize category names on blobs cached before the i18n change, which
        // stored a collapsed string instead of the full { en, ka } object — a
        // cache hit otherwise returns the un-localizable name to clients until
        // the entry expires or rebuilds.
        if (Array.isArray(ht.categoryOptions)) {
          ht.categoryOptions = ht.categoryOptions.reduce<DraftCategory[]>((acc, category) => {
            if (!category || typeof category !== 'object') return acc;
            const normalizedName = normalizeI18nName((category as { name?: unknown }).name);
            if (typeof (category as { id?: unknown }).id !== 'string' || normalizedName === null) return acc;
            acc.push({ ...(category as DraftCategory), name: normalizedName });
            return acc;
          }, []);
        }
      }
      cached.clueReveals ??= {};
      cached.revealAcks ??= {};
      await mergeAnswerOverlay(redis, cached);
      span.setAttribute('quizball.cache_hit', true);
      return cached;
    } catch (error) {
      span.setAttribute('quizball.cache_parse_failed', true);
      logger.warn({ error, matchId }, 'Failed to parse match cache, deleting key');
      await redis.del(matchCacheKey(matchId));
      return null;
    }
  });
}

interface OverlayPlayerTotals {
  totalPoints: number;
  correctAnswers: number;
}

/**
 * Merge the per-question answer overlay (see matchAnswersOverlayKey) into a
 * freshly read cache blob: overlay answers win per user, and the committing
 * player's running totals (written atomically with the answer) override the
 * possibly older blob totals.
 */
async function mergeAnswerOverlay(
  redis: NonNullable<ReturnType<typeof getRedisClient>>,
  cached: MatchCache
): Promise<void> {
  try {
    const revealAcks = cached.revealAcks ??= {};
    const overlay = await redis.hGetAll(matchAnswersOverlayKey(cached.matchId, cached.currentQIndex));
    for (const [field, value] of Object.entries(overlay)) {
      if (field.startsWith('a:')) {
        const userId = field.slice(2);
        cached.answers[userId] = JSON.parse(value) as CachedAnswer;
      } else if (field.startsWith('r:')) {
        const userId = field.slice(2);
        const revealAtMs = Number(value);
        if (Number.isFinite(revealAtMs)) {
          revealAcks[userId] = { qIndex: cached.currentQIndex, revealAtMs: Math.round(revealAtMs) };
        }
      } else if (field.startsWith('t:')) {
        const userId = field.slice(2);
        const totals = JSON.parse(value) as OverlayPlayerTotals;
        const player = cached.players.find((candidate) => candidate.userId === userId);
        if (player) {
          player.totalPoints = Math.max(player.totalPoints, totals.totalPoints);
          player.correctAnswers = Math.max(player.correctAnswers, totals.correctAnswers);
        }
      }
    }
  } catch (error) {
    logger.warn(
      { error, matchId: cached.matchId, qIndex: cached.currentQIndex },
      'Failed to merge answer overlay into match cache'
    );
  }
}

/**
 * Persist a committed answer WITHOUT rewriting the whole cache blob: one
 * small HSET into the per-question overlay (answer + the player's running
 * totals, so reads stay consistent). The caller must have already mutated
 * the in-memory cache the same way.
 */
export async function commitCachedAnswer(cache: MatchCache, answer: CachedAnswer): Promise<void> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return;
  const key = matchAnswersOverlayKey(cache.matchId, cache.currentQIndex);
  const player = cache.players.find((candidate) => candidate.userId === answer.userId);
  const fields: Record<string, string> = {
    [`a:${answer.userId}`]: JSON.stringify(answer),
  };
  if (player) {
    fields[`t:${answer.userId}`] = JSON.stringify({
      totalPoints: player.totalPoints,
      correctAnswers: player.correctAnswers,
    } satisfies OverlayPlayerTotals);
  }
  try {
    await redis.hSet(key, fields);
    await redis.expire(key, MATCH_CACHE_TTL_SEC);
  } catch (error) {
    logger.error(
      { error, matchId: cache.matchId, qIndex: cache.currentQIndex, userId: answer.userId },
      'Failed to write answer overlay; falling back to full cache write'
    );
    await setMatchCache(cache);
  }
}

export async function commitCachedRevealAck(
  cache: MatchCache,
  userId: string,
  revealAtMs: number
): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) return false;
  const key = matchAnswersOverlayKey(cache.matchId, cache.currentQIndex);
  let stored: boolean;
  try {
    stored = await redis.hSetNX(key, `r:${userId}`, String(Math.round(revealAtMs)));
  } catch (error) {
    logger.error(
      { error, matchId: cache.matchId, qIndex: cache.currentQIndex, userId },
      'Failed to write reveal ack overlay; falling back to full cache write'
    );
    await setMatchCache(cache);
    return true;
  }
  // TTL refresh failure must not flip a lost hSetNX race into a full cache
  // write — that would stomp the winning ack (and concurrent overlay writes
  // from the other replica).
  try {
    await redis.expire(key, MATCH_CACHE_TTL_SEC);
  } catch (error) {
    logger.warn(
      { error, matchId: cache.matchId, qIndex: cache.currentQIndex, userId },
      'Failed to refresh reveal ack overlay TTL'
    );
  }
  return stored;
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
    const players = await matchPlayersRepo.listMatchPlayers(matchId);
    const state = sanitizePossessionState(match.state_payload, match.mode);

    const cache = buildInitialCache({
      match,
      players,
      state,
    });

    // Take the freshest of the two q-index signals: routine rounds only touch
    // the current_q_index column (cheap heartbeat), while the embedded state
    // is checkpointed at phase boundaries — either may be ahead of the other
    // depending on where the last write happened. Monotonic max can't rewind.
    const currentQuestionIndex = Math.max(
      state.currentQuestion?.qIndex ?? 0,
      match.current_q_index ?? 0
    );
    cache.currentQIndex = currentQuestionIndex;
    span.setAttribute('quizball.current_q_index', currentQuestionIndex);
    const rawQuestionPayload = await matchesService.buildMatchQuestionPayload(matchId, currentQuestionIndex);
    const questionPayload = normalizeMatchQuestionPayload(rawQuestionPayload);
    const timing = questionPayload
      ? await matchQuestionsRepo.getMatchQuestionTiming(matchId, currentQuestionIndex)
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
      const answers = await matchAnswersRepo.listAnswersForQuestion(matchId, currentQuestionIndex);
      cache.answers = toCachedAnswer(answers);
      cache.revealAcks = {};
    } else {
      cache.currentQuestion = null;
      cache.answers = {};
      cache.revealAcks = {};
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
    throw new ExternalServiceError('Redis unavailable for countdown state');
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
