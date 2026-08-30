import { logger } from '../core/logger.js';
import { getRandom } from '../core/rng.js';
import { harnessDelayMs } from '../core/harness-timing.js';
import type { MatchQuestionEvaluation } from '../modules/matches/matches.service.js';
import { matchAnswersRepo } from '../modules/matches/match-answers.repo.js';
import { matchPlayersRepo } from '../modules/matches/match-players.repo.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import { usersRepo } from '../modules/users/users.repo.js';
import { isPersistentBot } from '../modules/users/ai-classification.js';
import { parseBotModelParams, type BotModelParams } from '../modules/bots/calibration/params-schema.js';
import { HARD_THETA_CEILING_FALLBACK } from '../modules/bots/calibration/hard-clamps.js';
import { questionStatsRepo, type QuestionModelInputs } from '../modules/bots/question-stats.repo.js';
import type { PersistentBotModelPin } from '../modules/lobbies/lobbies.types.js';
import {
  decideClue,
  decideCountdownFoundCount,
  decideMcq,
  decidePutInOrderCorrectCount,
  resolveQuestionStats,
  topCohortSpeedFloorMs,
  type ClueSolveStats,
  type PersistentBotSkillInputs,
} from './persistent-bot-gameplay.js';
import { withAnswerLock } from './possession-answer-lock.js';
import { RANKED_AI_CORRECTNESS, rankedAiMatchKey } from './ai-ranked.constants.js';
import {
  answerCount,
  getCachedPlayer,
  getExpectedUserIds,
  getMatchCacheOrRebuild,
  hasUserAnswered,
  setMatchCache,
  type CachedAnswer,
} from './match-cache.js';
import { getRedisClient } from './redis.js';
import { questionTimerKey, countdownPlayerKey } from './match-keys.js';
import { cancelRealtimeTimer, scheduleRealtimeTimer } from './realtime-timer-scheduler.js';
import type { QuizballServer } from './socket-server.js';
import type { MatchPhaseKind, MatchQuestionKind } from './socket.types.js';
import { clamp, calculatePoints, calculateCountdownScore, calculatePutInOrderScore, calculateCluesScore } from './scoring.js';
import {
  getQuestionDurationMs,
  getQuestionPreAnswerDelayMs,
  type Seat,
} from './possession-state.js';
import {
  answerLogFields,
  cacheLogFields,
  questionLogFields,
} from './possession-debug-logging.js';

type ResolveRoundFn = (io: QuizballServer, matchId: string, qIndex: number, isTimeout: boolean) => Promise<void>;

const AI_ANSWER_TIMEOUT_BUFFER_MS = 250;
const AI_ANSWER_LOCK_BUSY_RETRY_MS = 750;
const AI_ANSWER_MIN_RESUME_DELAY_MS = 75;
const AI_DELAY_MIN_MS = 800;
const AI_DELAY_QUESTION_BUFFER_MS = 1500;
const AI_DELAY_FALLBACK_MAX_MS = 9000;
const DEFAULT_AI_DELAY_PROFILE = { minMs: 2000, maxMs: 7000 };

export type AiDelayProfile = {
  minMs: number;
  maxMs: number;
};

type AiSettings = {
  aiCorrectness: number;
  aiDelayProfile: AiDelayProfile | null;
};

/**
 * The calibrated-model context for a PERSISTENT bot in this match, resolved from
 * the ranked_context pin + validated params. Null for ephemeral bots or when the
 * pin is absent (the bot falls back to the bridge path). Skill inputs are frozen
 * at match creation; params are pinned so a mid-match refresh cannot alter them.
 */
type PersistentModelContext = {
  params: BotModelParams;
  inputs: PersistentBotSkillInputs;
  botUserId: string;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A category-affinity map is valid iff every value is a finite number. */
function parseCategoryAffinities(value: unknown): Record<string, number> | null {
  if (value == null) return {};
  const record = asRecord(value);
  if (!record) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!isFiniteNumber(v)) return null;
    out[k] = v;
  }
  return out;
}

/**
 * Validate EVERY field the gameplay model reads before trusting a pin. A
 * partial or older-written pin (missing/non-finite personalOffset,
 * governorAdjustment, dailyFormSeed, thetaCeilingBound, currentRp, or a
 * non-object params) must be treated as ABSENT — return null so the caller
 * falls back to the RP bridge — rather than letting an undefined leak into theta
 * and NaN-poison every decision. thetaCeilingBound is the only field allowed to
 * be missing (older pins pre-date it); it then defaults to the conservative
 * frozen fallback so the ceiling is still enforced.
 */
export function parsePersistentBotModelPin(ctx: unknown): PersistentBotModelPin | null {
  const record = asRecord(ctx);
  const pin = record ? asRecord(record.persistentBotModel) : null;
  if (!pin) return null;

  if (typeof pin.botUserId !== 'string' || pin.botUserId.length === 0) return null;
  if (!isFiniteNumber(pin.currentRp)) return null;
  if (!isFiniteNumber(pin.personalOffset)) return null;
  if (!isFiniteNumber(pin.governorAdjustment)) return null;
  if (typeof pin.dailyFormSeed !== 'string' || pin.dailyFormSeed.length === 0) return null;
  // thetaCeilingBound: required to be finite IF present; a missing one is allowed
  // (older pin) and defaults later. A present-but-non-finite value is invalid.
  if (pin.thetaCeilingBound !== undefined && !isFiniteNumber(pin.thetaCeilingBound)) return null;
  const affinities = parseCategoryAffinities(pin.categoryAffinities);
  if (affinities === null) return null;
  if (pin.params == null || typeof pin.params !== 'object') return null;

  return {
    paramsVersion: isFiniteNumber(pin.paramsVersion) ? pin.paramsVersion : null,
    params: pin.params,
    botUserId: pin.botUserId,
    currentRp: pin.currentRp,
    personalOffset: pin.personalOffset,
    governorAdjustment: pin.governorAdjustment,
    categoryAffinities: affinities,
    dailyFormSeed: pin.dailyFormSeed,
    thetaCeilingBound: isFiniteNumber(pin.thetaCeilingBound)
      ? pin.thetaCeilingBound
      : HARD_THETA_CEILING_FALLBACK,
  };
}

function persistentModelFromPin(pin: PersistentBotModelPin): PersistentModelContext | null {
  try {
    // parsePersistentBotModelPin has already validated every scalar field is
    // finite; params still needs the full zod validation (and can throw).
    const params = parseBotModelParams(pin.params);
    const inputs: PersistentBotSkillInputs = {
      currentRp: pin.currentRp,
      personalOffset: pin.personalOffset,
      governorAdjustment: pin.governorAdjustment,
      categoryAffinities: pin.categoryAffinities ?? {},
      dailyFormSeed: pin.dailyFormSeed,
      thetaCeilingBound: pin.thetaCeilingBound,
    };
    return { params, inputs, botUserId: pin.botUserId };
  } catch (error) {
    logger.warn({ error, botUserId: pin.botUserId }, 'Persistent-bot model pin failed validation; using bridge');
    return null;
  }
}

type QuestionDifficulty = 'easy' | 'medium' | 'hard';

function normalizedDifficulty(difficulty?: string): QuestionDifficulty {
  if (difficulty === 'easy' || difficulty === 'medium' || difficulty === 'hard') {
    return difficulty;
  }
  return 'medium';
}

function difficultyCorrectnessMultiplier(difficulty?: string): number {
  switch (normalizedDifficulty(difficulty)) {
    case 'easy':
      return 1.35;
    case 'hard':
      return 0.65;
    case 'medium':
      return 1;
  }
}

function difficultyDelayMultiplier(difficulty?: string): number {
  switch (normalizedDifficulty(difficulty)) {
    case 'easy':
      return 0.6;
    case 'hard':
      return 1.4;
    case 'medium':
      return 1;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Extract an index->count histogram (number values) from a format_stats jsonb. */
function readHist(
  formatStats: Record<string, unknown> | null,
  key: string,
): Record<string, number> | undefined {
  const raw = formatStats ? formatStats[key] : undefined;
  const record = asRecord(raw);
  if (!record) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Extract the measured clue solve-rate pair from format_stats. Strict: the rate
 * must be a finite number in [0,1] and samples a finite non-negative integer —
 * anything else (strings, nulls, negatives, out-of-range) returns null and the
 * decision takes the exact legacy path.
 */
function readClueSolve(formatStats: Record<string, unknown> | null): ClueSolveStats | null {
  if (!formatStats) return null;
  const rate = formatStats.cluesSolveRate;
  const samples = formatStats.cluesSolveSamples;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) return null;
  if (typeof samples !== 'number' || !Number.isFinite(samples) || samples < 0 || !Number.isInteger(samples)) return null;
  return { rate, samples };
}

function parseAiDelayProfile(value: unknown): AiDelayProfile | null {
  const record = asRecord(value);
  if (!record) return null;
  const minMs = record.minMs;
  const maxMs = record.maxMs;
  if (
    typeof minMs !== 'number' ||
    typeof maxMs !== 'number' ||
    !Number.isFinite(minMs) ||
    !Number.isFinite(maxMs) ||
    minMs > maxMs
  ) {
    return null;
  }
  return {
    minMs: Math.round(minMs),
    maxMs: Math.round(maxMs),
  };
}

function aiSettingsFromRankedContext(ctx: unknown): AiSettings {
  const record = asRecord(ctx);
  if (!record) {
    return {
      aiCorrectness: RANKED_AI_CORRECTNESS,
      aiDelayProfile: null,
    };
  }

  const aiCorrectness = typeof record.aiCorrectness === 'number'
    ? record.aiCorrectness
    : RANKED_AI_CORRECTNESS;
  return {
    aiCorrectness,
    aiDelayProfile: parseAiDelayProfile(record.aiDelayProfile),
  };
}

function normalizeAiDelayProfile(profile?: AiDelayProfile | null): AiDelayProfile {
  if (!profile) return DEFAULT_AI_DELAY_PROFILE;
  return {
    minMs: Math.max(0, Math.min(profile.minMs, profile.maxMs)),
    maxMs: Math.max(0, Math.max(profile.minMs, profile.maxMs)),
  };
}

export function difficultyAdjustedCorrectness(base: number, difficulty?: string): number {
  return clamp(base * difficultyCorrectnessMultiplier(difficulty), 0.10, 0.97);
}

export function getAiAnswerDelayMs(options: {
  questionKind?: MatchQuestionKind;
  difficulty?: string;
  delayProfile?: AiDelayProfile | null;
  isCorrect?: boolean;
  questionTimeMs?: number | null;
} = {}): number {
  // Countdown is open-ended typing, so the AI uses a much slower range than other kinds.
  if (options.questionKind === 'countdown') {
    return harnessDelayMs(Math.floor(getRandom() * 10000) + 12000);
  }

  const profile = normalizeAiDelayProfile(options.delayProfile);
  const rangeMs = Math.max(0, profile.maxMs - profile.minMs);
  const baseMs = profile.minMs + Math.floor(getRandom() * (rangeMs + 1));
  const hesitationMultiplier = options.isCorrect === false
    ? 1.3 + getRandom() * 0.3
    : 1;
  const jitterMultiplier = 0.85 + getRandom() * 0.3;
  const rawDelayMs =
    baseMs *
    difficultyDelayMultiplier(options.difficulty) *
    hesitationMultiplier *
    jitterMultiplier;
  const maxDelayMs = typeof options.questionTimeMs === 'number' && Number.isFinite(options.questionTimeMs)
    ? Math.max(AI_DELAY_MIN_MS, options.questionTimeMs - AI_DELAY_QUESTION_BUFFER_MS)
    : AI_DELAY_FALLBACK_MAX_MS;
  return harnessDelayMs(Math.round(clamp(rawDelayMs, AI_DELAY_MIN_MS, maxDelayMs)));
}

function pickIncorrectIndex(correctIndex: number, optionCount: number): number {
  const candidates = Array.from({ length: optionCount }, (_, index) => index).filter(
    (index) => index !== correctIndex
  );
  const picked = candidates[Math.floor(getRandom() * candidates.length)];
  return picked ?? correctIndex;
}

function getAiCountdownFoundCount(totalAnswers: number, aiCorrectness: number): number {
  const cappedAnswers = Math.max(1, totalAnswers);
  const baseline = Math.round(cappedAnswers * aiCorrectness * 0.75);
  const variance = Math.floor(getRandom() * 3) - 1;
  return clamp(baseline + variance, 0, cappedAnswers);
}

function getAiClueIndex(clueCount: number, aiCorrectness: number): number {
  const maxIndex = Math.max(0, clueCount - 1);
  const weighted = Math.round((1 - aiCorrectness) * maxIndex);
  const variance = Math.floor(getRandom() * 2);
  return clamp(weighted + variance, 0, maxIndex);
}

export function createPossessionAi(resolveRound: ResolveRoundFn) {
  const aiUserIdByMatch = new Map<string, string | null>();
  const aiSettingsForMatch = new Map<string, AiSettings>();
  // undefined = not yet resolved; null = resolved-and-absent (ephemeral or no pin).
  const persistentModelByMatch = new Map<string, PersistentModelContext | null>();
  // Stats snapshot per (matchId:questionId): resolved ONCE at first decision and
  // reused for every subsequent read (commit, recompute) so a mid-match
  // question_stats refresh cannot change a bot's later or re-derived decisions
  // (Sol MEDIUM). Equivalent immutability to the pinned params. null = "resolved,
  // no stats row" (still cached so we don't re-hit the DB).
  const questionStatsByKey = new Map<string, QuestionModelInputs | null>();

  /**
   * Read + PIN the question_stats model inputs for a question in this match. The
   * first read is cached; every later read for the same (matchId,questionId)
   * returns the pinned snapshot, so a refresh mid-match is invisible to the live
   * bot. A read failure caches null (skill fallback) rather than retrying.
   */
  async function pinnedQuestionStats(matchId: string, questionId: string): Promise<QuestionModelInputs | null> {
    const cacheKey = `${matchId}:${questionId}`;
    if (questionStatsByKey.has(cacheKey)) return questionStatsByKey.get(cacheKey) ?? null;
    let inputs: QuestionModelInputs | null = null;
    try {
      inputs = await questionStatsRepo.getModelInputsForQuestion(questionId);
    } catch (error) {
      logger.warn({ error, matchId, questionId }, 'question_stats read failed; model uses global fallback');
    }
    questionStatsByKey.set(cacheKey, inputs);
    return inputs;
  }

  /**
   * Resolve the calibrated model for this match's AI, if it is a persistent bot
   * with a pinned model in ranked_context. Cached per match. Returns null for
   * ephemeral bots or a missing/invalid pin (→ the bridge path is used).
   */
  async function resolvePersistentModelForMatch(matchId: string): Promise<PersistentModelContext | null> {
    const cached = persistentModelByMatch.get(matchId);
    if (cached !== undefined) return cached;

    const aiUserId = await resolveAiUserIdForMatch(matchId);
    if (!aiUserId) {
      persistentModelByMatch.set(matchId, null);
      return null;
    }
    // A failure here must NOT abort scheduling — the ephemeral path continues
    // exactly as before (Sol LOW: ephemeral must stay operationally byte-
    // identical). Any throw resolves the model to null → bridge path.
    try {
      const aiUser = await usersRepo.getById(aiUserId);
      if (!aiUser || !isPersistentBot(aiUser)) {
        persistentModelByMatch.set(matchId, null);
        return null;
      }
      const match = await matchesRepo.getMatch(matchId);
      const pin = parsePersistentBotModelPin(match?.ranked_context);
      const model = pin ? persistentModelFromPin(pin) : null;
      persistentModelByMatch.set(matchId, model);
      return model;
    } catch (error) {
      logger.warn({ error, matchId, aiUserId }, 'Persistent-model resolution failed; using bridge path');
      persistentModelByMatch.set(matchId, null);
      return null;
    }
  }

  /**
   * Compute the persistent bot's seeded decision for one question. Reads live
   * question_stats, resolves the backoff chain, and applies the calibrated
   * model. Deterministic in (botId,matchId,questionId,params) and independent of
   * the human's answer. Returns a normalized decision; countdown/put-in-order
   * expose their per-format counts, clue/mcq expose isCorrect (+clue index).
   */
  async function computePersistentQuestionDecision(
    model: PersistentModelContext,
    matchId: string,
    questionId: string,
    questionKind: MatchQuestionKind,
    clueCount?: number,
  ): Promise<{
    isCorrect: boolean;
    clueIndex: number | null;
    /** Calibrated think-time (ms), already floored by the top-cohort speed floor. */
    answerTimeMs: number;
  }> {
    const keys = { botId: model.botUserId, matchId, questionId };
    const statsInputs = await pinnedQuestionStats(matchId, questionId);

    const global = statsInputs?.global
      ?? { answersCount: 0, correctCount: 0, smoothedAccuracy: null, timingSamples: 0, medianTimeMs: null, logTimeSigma: null };
    const resolved = resolveQuestionStats(
      statsInputs?.perQuestion ?? null,
      statsInputs?.categoryType ?? null,
      statsInputs?.type ?? null,
      global,
    );
    const categorySlug = statsInputs?.categorySlug ?? null;
    const formatStats = statsInputs?.formatStats ?? null;

    // The mcq decision yields both the Bernoulli correctness (mcq only) AND the
    // calibrated, speed-floor-clamped answer time, which all formats reuse for
    // their think-time (the timing model is shared).
    const mcq = decideMcq(model.params, model.inputs, resolved, categorySlug, keys);

    // Schedule time only needs correctness (for the delay hesitation), the clue
    // reveal index (drives the clue answer time), and the think-time. The
    // countdown / put-in-order COUNTS are NOT needed here — they are re-derived
    // deterministically at commit with the REAL group/item count, so nothing is
    // computed against an unknown total here.
    if (questionKind === 'countdown') {
      // Countdown isCorrect is always false (opponent-relative), matching the
      // ephemeral path; the found-count is decided at commit.
      return { isCorrect: false, clueIndex: null, answerTimeMs: mcq.answerTimeMs };
    }
    if (questionKind === 'putInOrder') {
      // Correctness comes from the calibrated partial-credit count (all-placed =
      // correct) at commit, NOT the Bernoulli draw. Schedule-time isCorrect stays
      // false (only affects the hesitation multiplier).
      return { isCorrect: false, clueIndex: null, answerTimeMs: mcq.answerTimeMs };
    }
    if (questionKind === 'clues') {
      // The calibrated reveal-index distribution IS the performance metric (NOT a
      // Bernoulli gate). decideClue returns whether the bot solves at all (a
      // coarse 1-clue question can score 100, so it must sometimes NOT solve to
      // respect the ceiling) and the reveal index it solves at.
      const dist = readHist(formatStats, 'clueRevealIndexDistribution');
      const clue = decideClue(model.params, model.inputs, dist, clueCount ?? 1, keys, readClueSolve(formatStats));
      return { isCorrect: clue.solved, clueIndex: clue.index, answerTimeMs: mcq.answerTimeMs };
    }
    return { isCorrect: mcq.isCorrect, clueIndex: null, answerTimeMs: mcq.answerTimeMs };
  }

  /** Commit-time countdown found-count via the calibrated distribution + real total. */
  async function computePersistentCountdownFoundCount(
    model: PersistentModelContext,
    matchId: string,
    questionId: string,
    totalGroups: number,
  ): Promise<number> {
    const stats = await pinnedQuestionStats(matchId, questionId);
    const dist = readHist(stats?.formatStats ?? null, 'countdownFoundCountDistribution');
    return decideCountdownFoundCount(model.params, model.inputs, dist, totalGroups, {
      botId: model.botUserId,
      matchId,
      questionId,
    });
  }

  /** Commit-time put-in-order partial credit via the calibrated distribution + real total. */
  async function computePersistentPutInOrderCount(
    model: PersistentModelContext,
    matchId: string,
    questionId: string,
    totalItems: number,
  ): Promise<number> {
    const stats = await pinnedQuestionStats(matchId, questionId);
    const dist = readHist(stats?.formatStats ?? null, 'putInOrderCorrectCountDistribution');
    return decidePutInOrderCorrectCount(model.params, model.inputs, dist, totalItems, {
      botId: model.botUserId,
      matchId,
      questionId,
    });
  }

  /** Commit-time clue decision (solve + reveal index) via the calibrated distribution + real clue count. */
  async function computePersistentClue(
    model: PersistentModelContext,
    matchId: string,
    questionId: string,
    clueCount: number,
  ): Promise<{ solved: boolean; index: number }> {
    const stats = await pinnedQuestionStats(matchId, questionId);
    const dist = readHist(stats?.formatStats ?? null, 'clueRevealIndexDistribution');
    return decideClue(model.params, model.inputs, dist, clueCount, {
      botId: model.botUserId,
      matchId,
      questionId,
    }, readClueSolve(stats?.formatStats ?? null));
  }

  function fireAndForget(label: string, fn: () => Promise<unknown>): void {
    fn().catch((error) => {
      logger.error({ error, label }, 'Fire-and-forget DB write failed');
    });
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

    const players = await matchPlayersRepo.listMatchPlayers(matchId);
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

  async function resolveAiSettingsForMatch(matchId: string): Promise<AiSettings> {
    const cached = aiSettingsForMatch.get(matchId);
    if (cached) return cached;

    const match = await matchesRepo.getMatch(matchId);
    const settings = aiSettingsFromRankedContext(match?.ranked_context);
    aiSettingsForMatch.set(matchId, settings);
    return settings;
  }

  async function resolveAiCorrectnessForMatch(matchId: string): Promise<number> {
    const settings = await resolveAiSettingsForMatch(matchId);
    return settings.aiCorrectness;
  }

  function clearAiAnswerTimer(matchId: string, qIndex: number): void {
    const key = questionTimerKey(matchId, qIndex);
    void cancelRealtimeTimer('possession_ai_answer', key).catch((error) => {
      logger.warn({ error, matchId, qIndex }, 'Failed to cancel possession AI answer timer');
    });
  }

  async function schedulePossessionAiAnswer(
    _io: QuizballServer,
    matchId: string,
    qIndex: number,
    options: {
      questionKind: MatchQuestionKind;
      evaluation: MatchQuestionEvaluation;
      phaseKind: MatchPhaseKind;
      phaseRound: number;
      shooterSeat: Seat | null;
      playableAt?: Date;
      deadlineAt?: Date;
    }
  ): Promise<void> {
    const key = questionTimerKey(matchId, qIndex);
    clearAiAnswerTimer(matchId, qIndex);
    const cache = await getMatchCacheOrRebuild(matchId);
    if (!cache || cache.status !== 'active') {
      logger.warn(
        { eventName: 'possession_ai_answer', matchId, qIndex, ...cacheLogFields(cache) },
        'Possession AI answer schedule skipped: inactive or missing cache'
      );
      return;
    }
    if (cache.currentQIndex !== qIndex) {
      logger.warn(
        { eventName: 'possession_ai_answer', matchId, qIndex, ...cacheLogFields(cache) },
        'Possession AI answer schedule skipped: qIndex mismatch'
      );
      return;
    }
    if (!cache.currentQuestion) {
      logger.warn(
        { eventName: 'possession_ai_answer', matchId, qIndex, ...cacheLogFields(cache) },
        'Possession AI answer schedule skipped: missing current question'
      );
      return;
    }

    const aiUserId = await resolveAiUserIdForMatch(matchId);
    if (!aiUserId) return;

    const hasAi = cache.players.some((player) => player.userId === aiUserId);
    if (!hasAi) {
      logger.warn(
        { eventName: 'possession_ai_answer', matchId, qIndex, aiUserId, ...cacheLogFields(cache) },
        'Possession AI answer schedule skipped: AI user is not a match player'
      );
      return;
    }

    const expectedUserIds = getExpectedUserIds(cache);
    if (!expectedUserIds.includes(aiUserId)) {
      logger.warn(
        { eventName: 'possession_ai_answer', matchId, qIndex, aiUserId, expectedUserIds, ...questionLogFields(cache.currentQuestion) },
        'Possession AI answer schedule skipped: AI user is not expected for this question'
      );
      return;
    }

    const nowMs = Date.now();
    const playableAtMs = options.playableAt?.getTime();
    const deadlineAtMs = options.deadlineAt?.getTime();
    const hasAuthoritativeWindow =
      Number.isFinite(playableAtMs) &&
      Number.isFinite(deadlineAtMs) &&
      (deadlineAtMs as number) > (playableAtMs as number);
    const preAnswerDelayMs = hasAuthoritativeWindow
      ? Math.max(0, (playableAtMs as number) - nowMs)
      : getQuestionPreAnswerDelayMs({
          qIndex,
          state: cache.statePayload,
        });
    const aiSettings = await resolveAiSettingsForMatch(matchId);
    const questionDifficulty = cache.currentQuestion.questionDTO.difficulty;
    const aiCorrectness = difficultyAdjustedCorrectness(aiSettings.aiCorrectness, questionDifficulty);
    const clueCountForDelay = options.questionKind === 'clues' && options.evaluation.kind === 'clues'
      ? options.evaluation.clues.length
      : undefined;

    // PERSISTENT-BOT branch: the calibrated model decides correctness (and clue
    // reveal index) seeded by (botId,matchId,questionId), reading live
    // question_stats. Ephemeral bots keep the bridge draw below. Countdown/
    // put-in-order correctness is not a Bernoulli here either — they resolve at
    // commit time via their per-format models, so plannedIsCorrect stays false
    // for countdown exactly as the bridge does.
    const persistentModel = await resolvePersistentModelForMatch(matchId);
    const persistentDecision = persistentModel
      ? await computePersistentQuestionDecision(
          persistentModel,
          matchId,
          cache.currentQuestion.questionId,
          options.questionKind,
          clueCountForDelay,
        )
      : null;

    // Persistent bots: PIN the per-format outcomes NOW, using the REAL group/
    // item/clue counts available in options.evaluation, and carry them through
    // the durable timer payload so commit reads them instead of recomputing from
    // (possibly refreshed) live stats. Replica/restart/refresh-safe (Sol High).
    let plannedFoundCount: number | null = null;
    let plannedPutInOrderCount: number | null = null;
    let plannedClueSolved: boolean | null = null;
    const questionId = cache.currentQuestion.questionId;
    if (persistentModel) {
      if (options.questionKind === 'countdown' && options.evaluation.kind === 'countdown') {
        plannedFoundCount = await computePersistentCountdownFoundCount(
          persistentModel, matchId, questionId, options.evaluation.answerGroups.length,
        );
      } else if (options.questionKind === 'putInOrder' && options.evaluation.kind === 'putInOrder') {
        plannedPutInOrderCount = await computePersistentPutInOrderCount(
          persistentModel, matchId, questionId, options.evaluation.items.length,
        );
      } else if (options.questionKind === 'clues' && options.evaluation.kind === 'clues') {
        const clue = await computePersistentClue(
          persistentModel, matchId, questionId, options.evaluation.clues.length,
        );
        plannedClueSolved = clue.solved;
      }
    }

    const plannedIsCorrect = options.questionKind === 'countdown'
      ? false
      : persistentDecision
        ? persistentDecision.isCorrect
        : getRandom() < aiCorrectness;
    const plannedClueIndex = typeof clueCountForDelay === 'number'
      ? (persistentDecision?.clueIndex ?? getAiClueIndex(clueCountForDelay, aiCorrectness))
      : null;
    const questionTimeMsForDelay = hasAuthoritativeWindow
      ? Math.max(0, (deadlineAtMs as number) - (playableAtMs as number))
      : getQuestionDurationMs(options.questionKind, clueCountForDelay);
    // Persistent bots take their think-time from the calibrated timing model
    // (log-normal from question_stats, floored by the top-cohort speed floor).
    // Countdown is exempt: it is open-ended typing whose pace is driven by the
    // drip-feed, not a single answer time, so it keeps the existing slow range.
    // Ephemeral bots keep the bridge delay. The window-clamping machinery below
    // (authoritative deadline, buffers) is unchanged for both.
    const aiThinkTimeMs = persistentDecision && options.questionKind !== 'countdown'
      ? clamp(persistentDecision.answerTimeMs, 0, questionTimeMsForDelay)
      : getAiAnswerDelayMs({
          questionKind: options.questionKind,
          difficulty: questionDifficulty,
          delayProfile: aiSettings.aiDelayProfile,
          isCorrect: plannedIsCorrect,
          questionTimeMs: questionTimeMsForDelay,
        });
    let plannedAnswerTimeMs = plannedClueIndex !== null && clueCountForDelay && clueCountForDelay > 0
      ? (() => {
          const clueSliceMs = questionTimeMsForDelay / clueCountForDelay;
          // Reading floor: a bot must not answer before it could plausibly have
          // READ the clue that just appeared — the instant index-0 answer on a
          // long clue was a visible tell. Floor scales with the revealed clue's
          // text length, bounded inside the slice so the slice arithmetic (and
          // the deadline clamp below, which may still pull the final-slice
          // answer earlier — accepted edge) is never violated.
          const clueText = options.questionKind === 'clues' && options.evaluation.kind === 'clues'
            ? (options.evaluation.clues[plannedClueIndex]?.content?.en
              ?? options.evaluation.clues[plannedClueIndex]?.content?.ka ?? '')
            : '';
          const readFloorMs = Math.min(clueSliceMs - 250, 900 + clueText.length * 25);
          const withinSlice = clamp(aiThinkTimeMs, Math.max(0, readFloorMs), clueSliceMs - 250);
          return clamp(
            Math.round(clueSliceMs * plannedClueIndex + withinSlice),
            0,
            questionTimeMsForDelay
          );
        })()
      : clamp(aiThinkTimeMs, 0, questionTimeMsForDelay);
    let dueAtMs = nowMs + preAnswerDelayMs + plannedAnswerTimeMs;
    if (hasAuthoritativeWindow) {
      const latestDueAtMs = Math.max(nowMs + AI_ANSWER_MIN_RESUME_DELAY_MS, (deadlineAtMs as number) - AI_ANSWER_TIMEOUT_BUFFER_MS);
      if (dueAtMs > latestDueAtMs) {
        dueAtMs = latestDueAtMs;
        plannedAnswerTimeMs = clamp(dueAtMs - nowMs - preAnswerDelayMs, 0, questionTimeMsForDelay);
      }
    }
    await scheduleRealtimeTimer('possession_ai_answer', key, new Date(dueAtMs), {
      kind: 'possession_ai_answer',
      matchId,
      qIndex,
      plannedAnswerTimeMs,
      plannedClueIndex,
      plannedIsCorrect,
      plannedFoundCount,
      plannedPutInOrderCount,
      plannedClueSolved,
    });
    logger.info(
      {
        eventName: 'possession_ai_answer',
        matchId,
        qIndex,
        aiUserId,
        questionKind: options.questionKind,
        phaseKind: options.phaseKind,
        phaseRound: options.phaseRound,
        shooterSeat: options.shooterSeat,
        authoritativeWindow: hasAuthoritativeWindow,
        preAnswerDelayMs,
        aiThinkTimeMs,
        aiCorrectness,
        questionDifficulty,
        plannedAnswerTimeMs,
        plannedClueIndex,
        plannedIsCorrect,
        playableAt: hasAuthoritativeWindow ? new Date(playableAtMs as number).toISOString() : null,
        dueAt: new Date(dueAtMs).toISOString(),
        deadlineAt: hasAuthoritativeWindow ? new Date(deadlineAtMs as number).toISOString() : null,
        ...questionLogFields(cache.currentQuestion),
      },
      'Scheduled possession AI answer'
    );
  }

  async function runPossessionAiAnswer(
    io: QuizballServer,
    matchId: string,
    qIndex: number,
    plannedAnswerTimeMs: number,
    plannedClueIndex: number | null,
    plannedIsCorrect?: boolean,
    plannedFoundCount?: number | null,
    plannedPutInOrderCount?: number | null,
    plannedClueSolved?: boolean | null,
  ): Promise<void> {
    try {
      const aiUserId = await resolveAiUserIdForMatch(matchId);
      if (!aiUserId) return;
      logger.info(
        {
          eventName: 'possession_ai_answer',
          matchId,
          qIndex,
          aiUserId,
          plannedAnswerTimeMs,
          plannedClueIndex,
          plannedIsCorrect,
        },
        'Possession AI answer timer fired'
      );

      let roundLockBusy = false;
      const onRoundLockBusy = () => {
        roundLockBusy = true;
        logger.warn(
          { eventName: 'possession_ai_answer', matchId, qIndex, aiUserId },
          'Possession AI answer deferred: round lock busy'
        );
      };

      type AiCommitted = {
        questionKind: MatchQuestionKind;
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
        foundCount?: number;
        foundAnswerIds?: string[];
        submittedOrderIds?: string[];
        clueIndex?: number | null;
      };

      // Phase A (unlocked): read the cache and compute the AI's decision. The
      // model/settings resolution below can hit the DB (persistent-bot stats,
      // ranked context) — holding the shared round lock across it would starve
      // human answer commits into MATCH_BUSY drops.
      const fresh = await getMatchCacheOrRebuild(matchId);
      if (!fresh || fresh.status !== 'active') {
        logger.warn(
          { eventName: 'possession_ai_answer', matchId, qIndex, aiUserId, ...cacheLogFields(fresh) },
          'Possession AI answer skipped: inactive or missing cache'
        );
        return;
      }
      if (fresh.currentQIndex !== qIndex || !fresh.currentQuestion) {
        logger.warn(
          { eventName: 'possession_ai_answer', matchId, qIndex, aiUserId, ...cacheLogFields(fresh), ...questionLogFields(fresh.currentQuestion) },
          'Possession AI answer skipped: stale or missing current question'
        );
        return;
      }
      if (hasUserAnswered(fresh, aiUserId)) {
        logger.info(
          { eventName: 'possession_ai_answer', matchId, qIndex, aiUserId, ...questionLogFields(fresh.currentQuestion) },
          'Possession AI answer skipped: AI already answered'
        );
        return;
      }

      const expected = getExpectedUserIds(fresh);
      if (!expected.includes(aiUserId)) {
        logger.warn(
          { eventName: 'possession_ai_answer', matchId, qIndex, aiUserId, expectedUserIds: expected, ...questionLogFields(fresh.currentQuestion) },
          'Possession AI answer skipped: AI user is not expected for this question'
        );
        return;
      }

      const question = fresh.currentQuestion;
      const aiPlayer = getCachedPlayer(fresh, aiUserId);
      if (!aiPlayer) {
        logger.warn(
          { eventName: 'possession_ai_answer', matchId, qIndex, aiUserId, ...cacheLogFields(fresh) },
          'Possession AI answer skipped: AI user is not a match player'
        );
        return;
      }

      const baseAiCorrectness = await resolveAiCorrectnessForMatch(matchId);
      const aiCorrectness = difficultyAdjustedCorrectness(baseAiCorrectness, question.questionDTO.difficulty);
      // Persistent bot: the per-format counts (countdown found / put-in-order
      // partial credit) come from the calibrated distributions, re-derived
      // deterministically here with the REAL group/item count. mcq/clue
      // correctness was already decided by the model at schedule time and is
      // threaded via plannedIsCorrect / plannedClueIndex.
      const persistentModel = await resolvePersistentModelForMatch(matchId);
      const clueCountForDuration = question.kind === 'clues' && question.evaluation.kind === 'clues'
        ? question.evaluation.clues.length
        : undefined;
      const questionTimeMs = getQuestionDurationMs(question.kind, clueCountForDuration);
      // Persistent bots: floor the COMMITTED time at the top-cohort speed floor
      // (countdown exempt — its pace is the drip-feed). Scheduling may have
      // pulled plannedAnswerTimeMs down to the window/deadline; the floor is
      // re-asserted end-to-end so a persistent bot is never faster than the
      // measured fastest real cohort (Sol HIGH #3). The floor is capped by the
      // question window so it can never exceed the deadline.
      const persistentSpeedFloorMs = persistentModel && question.kind !== 'countdown'
        ? Math.min(topCohortSpeedFloorMs(persistentModel.params), questionTimeMs)
        : 0;
      const answerTimeMs = clamp(plannedAnswerTimeMs, persistentSpeedFloorMs, questionTimeMs);
      let isCorrect = false;
      let selectedIndex: number | null = null;
      let pointsEarned = 0;
      let foundCount: number | undefined;
      let foundAnswerIds: string[] | undefined;
      let submittedOrderIds: string[] | undefined;
      let clueIndex: number | null | undefined;

      if (question.kind === 'multipleChoice' && question.evaluation.kind === 'multipleChoice') {
        const optionCount = question.questionDTO.kind === 'multipleChoice'
          ? question.questionDTO.options.length
          : 4;
        isCorrect = plannedIsCorrect ?? (getRandom() < aiCorrectness);
        selectedIndex = isCorrect
          ? question.evaluation.correctIndex
          : pickIncorrectIndex(question.evaluation.correctIndex, optionCount);
        pointsEarned = calculatePoints(isCorrect, answerTimeMs, questionTimeMs);
      } else if (question.kind === 'countdown' && question.evaluation.kind === 'countdown') {
        const totalGroups = question.evaluation.answerGroups.length;
        if (persistentModel) {
          // Prefer the value PINNED at schedule time (durable timer payload);
          // recompute only if this timer predates the pin (in-flight upgrade).
          foundCount = plannedFoundCount ?? await computePersistentCountdownFoundCount(persistentModel, matchId, question.questionId, totalGroups);
        } else {
          foundCount = getAiCountdownFoundCount(totalGroups, aiCorrectness);
        }
        foundAnswerIds = question.evaluation.answerGroups.slice(0, foundCount).map((group) => group.id);
        selectedIndex = foundCount;
        pointsEarned = calculateCountdownScore(foundCount, totalGroups);
        isCorrect = false;
      } else if (question.kind === 'putInOrder' && question.evaluation.kind === 'putInOrder') {
        const correctOrderIds = [...question.evaluation.items]
          .sort((left, right) => left.sortValue - right.sortValue)
          .map((item) => item.id);
        selectedIndex = null;
        const totalItems = question.evaluation.items.length;
        if (persistentModel) {
          // PERSISTENT: the calibrated partial-credit count IS the performance
          // metric (NOT a Bernoulli gate). isCorrect is derived from it (all
          // items placed = correct), and the submitted order always reflects
          // the ceiling-capped prefix — so a "correct" Bernoulli draw can never
          // slip the full correct order past the score cap (Sol HIGH).
          foundCount = plannedPutInOrderCount ?? await computePersistentPutInOrderCount(persistentModel, matchId, question.questionId, totalItems);
          isCorrect = foundCount >= totalItems;
          submittedOrderIds = [...correctOrderIds];
          if (submittedOrderIds.length > 1 && foundCount < submittedOrderIds.length) {
            const fixedPrefix = submittedOrderIds.slice(0, foundCount);
            const shuffledTail = submittedOrderIds.slice(foundCount).reverse();
            submittedOrderIds = [...fixedPrefix, ...shuffledTail];
          }
        } else {
          isCorrect = plannedIsCorrect ?? (getRandom() < aiCorrectness);
          // Wrong-answer scoring for put-in-order: scale `aiCorrectness`
          // by 0.55 so an AI that "would have" got the question right
          // (aiCorrectness=1.0) still places ~55% of items in the correct
          // prefix on a miss — partial credit that feels reasonable
          // without making wrong answers nearly as rewarding as right
          // ones. Mirrors the 0.75 factor used for countdown questions.
          foundCount = isCorrect
            ? totalItems
            : Math.min(
              totalItems - 1,
              Math.max(0, Math.round(totalItems * aiCorrectness * 0.55))
            );
          submittedOrderIds = [...correctOrderIds];
          if (!isCorrect && submittedOrderIds.length > 1) {
            const fixedPrefix = submittedOrderIds.slice(0, foundCount);
            const shuffledTail = submittedOrderIds.slice(foundCount).reverse();
            submittedOrderIds = [...fixedPrefix, ...shuffledTail];
          }
        }
        pointsEarned = calculatePutInOrderScore(foundCount, correctOrderIds.length);
      } else if (question.kind === 'clues' && question.evaluation.kind === 'clues') {
        selectedIndex = null;
        if (persistentModel) {
          // PERSISTENT: the calibrated clue decision (solve + reveal index) was
          // PINNED at schedule time. decideClue can decide NOT to solve — a
          // coarse (e.g. single-clue) question must sometimes fail so its SCORE
          // distribution respects the ceiling, never a deterministic 100. Prefer
          // the pinned solved flag + reveal index; recompute only for a pre-pin
          // in-flight timer.
          if (plannedClueSolved != null && plannedClueIndex != null) {
            isCorrect = plannedClueSolved;
            clueIndex = plannedClueIndex;
          } else {
            const clue = await computePersistentClue(
              persistentModel,
              matchId,
              question.questionId,
              question.evaluation.clues.length,
            );
            isCorrect = clue.solved;
            clueIndex = clue.index;
          }
        } else {
          isCorrect = plannedIsCorrect ?? (getRandom() < aiCorrectness);
          clueIndex = plannedClueIndex ?? getAiClueIndex(question.evaluation.clues.length, aiCorrectness);
        }
        pointsEarned = calculateCluesScore(isCorrect, clueIndex ?? 0);
      }

      const answer: CachedAnswer = {
        userId: aiUserId,
        questionKind: question.kind,
        selectedIndex,
        isCorrect,
        timeMs: answerTimeMs,
        pointsEarned,
        phaseKind: question.phaseKind,
        phaseRound: question.phaseRound,
        shooterSeat: question.shooterSeat,
        answeredAt: new Date().toISOString(),
        foundCount,
        foundAnswerIds,
        submittedOrderIds,
        clueIndex,
      };

      // Phase B (locked): re-validate and commit. The round may have resolved,
      // or this AI answer may have landed via another replica, while the
      // unlocked computation above ran.
      const committed = await withAnswerLock<AiCommitted | null>(matchId, 'round', onRoundLockBusy, async () => {
        const live = await getMatchCacheOrRebuild(matchId);
        if (!live || live.status !== 'active' || live.currentQIndex !== qIndex || !live.currentQuestion) {
          logger.warn(
            { eventName: 'possession_ai_answer', matchId, qIndex, aiUserId, ...cacheLogFields(live) },
            'Possession AI answer dropped: round no longer live at commit'
          );
          return null;
        }
        if (hasUserAnswered(live, aiUserId)) {
          logger.info(
            { eventName: 'possession_ai_answer', matchId, qIndex, aiUserId },
            'Possession AI answer dropped: AI already answered at commit'
          );
          return null;
        }
        const liveExpected = getExpectedUserIds(live);
        if (!liveExpected.includes(aiUserId)) return null;
        const livePlayer = getCachedPlayer(live, aiUserId);
        if (!livePlayer) return null;

        live.answers[aiUserId] = answer;
        if (question.kind === 'multipleChoice') {
          livePlayer.totalPoints += pointsEarned;
          if (isCorrect) livePlayer.correctAnswers += 1;
        }

        if (question.kind === 'countdown' && foundAnswerIds && foundAnswerIds.length > 0) {
          const redisClient = getRedisClient();
          if (redisClient?.isOpen) {
            const countdownKey = countdownPlayerKey(matchId, aiUserId);
            await redisClient.sAdd(countdownKey, foundAnswerIds);
            await redisClient.expire(countdownKey, 120);
          }
        }

        await setMatchCache(live);
        logger.info(
          {
            eventName: 'possession_ai_answer',
            matchId,
            qIndex,
            aiUserId,
            aiCorrectness,
            answerCount: answerCount(live),
            expectedCount: liveExpected.length,
            totalPoints: livePlayer.totalPoints + (question.kind === 'multipleChoice' ? 0 : pointsEarned),
            ...questionLogFields(question),
            ...answerLogFields(answer),
          },
          'Possession AI answer committed'
        );

        return {
          questionKind: question.kind,
          selectedIndex,
          isCorrect,
          answerTimeMs,
          pointsEarned,
          totalPoints: livePlayer.totalPoints + (question.kind === 'multipleChoice' ? 0 : pointsEarned),
          phaseKind: question.phaseKind,
          phaseRound: question.phaseRound,
          shooterSeat: question.shooterSeat,
          answerCount: answerCount(live),
          expectedCount: liveExpected.length,
          foundCount,
          foundAnswerIds,
          submittedOrderIds,
          clueIndex,
        };
      });

      if (committed === undefined && roundLockBusy) {
        // The durable timer was consumed when this handler fired; dropping the
        // run would leave the bot answerless for the round. Re-arm with the
        // original payload (awaited — a fire-and-forget can race scheduler
        // cleanup) and let the retry re-validate against the round, which
        // no-ops harmlessly if the lock holder resolved it meanwhile.
        await scheduleRealtimeTimer(
          'possession_ai_answer',
          questionTimerKey(matchId, qIndex),
          new Date(Date.now() + AI_ANSWER_LOCK_BUSY_RETRY_MS),
          {
            kind: 'possession_ai_answer',
            matchId,
            qIndex,
            plannedAnswerTimeMs,
            plannedClueIndex,
            plannedIsCorrect,
            plannedFoundCount,
            plannedPutInOrderCount,
            plannedClueSolved,
          }
        );
        return;
      }

      if (!committed) return;

      if (committed.questionKind === 'multipleChoice') {
        fireAndForget('insertMatchAnswer(ai)', async () => {
          await matchAnswersRepo.insertMatchAnswerIfMissing({
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
          await matchPlayersRepo.updatePlayerTotals(
            matchId,
            aiUserId,
            committed.pointsEarned,
            committed.isCorrect
          );
        });
      }

      if (committed.phaseKind !== 'penalty' && committed.questionKind !== 'countdown') {
        io.to(`match:${matchId}`).emit('match:opponent_answered', {
          matchId,
          qIndex,
          questionKind: committed.questionKind,
          opponentTotalPoints: committed.totalPoints,
          pointsEarned: committed.pointsEarned,
          isCorrect: committed.isCorrect,
          selectedIndex: committed.selectedIndex,
        });
        logger.info(
          {
            eventName: 'match:opponent_answered',
            matchId,
            qIndex,
            aiUserId,
            questionKind: committed.questionKind,
            isCorrect: committed.isCorrect,
            pointsEarned: committed.pointsEarned,
            selectedIndex: committed.selectedIndex,
          },
          'Possession AI opponent_answered emitted'
        );
      }

      // AI commits all countdown answers at once; drip-feed them so the human sees a typing pace.
      if (committed.questionKind === 'countdown' && committed.foundCount && committed.foundCount > 0) {
        const totalFound = committed.foundCount;
        const emitQIndex = qIndex;
        logger.info(
          {
            eventName: 'match:opponent_countdown_progress',
            matchId,
            qIndex,
            aiUserId,
            totalFound,
          },
          'Possession AI countdown drip scheduled'
        );
        for (let i = 1; i <= totalFound; i += 1) {
          const stepDelay = 600 + Math.floor(getRandom() * 800) + (i - 1) * 250;
          setTimeout(() => {
            void (async () => {
              try {
                // Skip if the round advanced before our timer fired.
                const liveCache = await getMatchCacheOrRebuild(matchId);
                if (!liveCache || liveCache.status !== 'active') return;
                if (liveCache.currentQIndex !== emitQIndex) return;
                io.to(`match:${matchId}`).emit('match:opponent_countdown_progress', {
                  matchId,
                  qIndex: emitQIndex,
                  opponentUserId: aiUserId,
                  foundCount: i,
                });
                logger.info(
                  {
                    eventName: 'match:opponent_countdown_progress',
                    matchId,
                    qIndex: emitQIndex,
                    aiUserId,
                    foundCount: i,
                    totalFound,
                  },
                  'Possession AI countdown progress emitted'
                );
              } catch (error) {
                logger.warn({ error, matchId, qIndex: emitQIndex }, 'AI countdown drip emit failed');
              }
            })();
          }, stepDelay);
        }
      }

      if (committed.questionKind !== 'countdown' && committed.answerCount >= committed.expectedCount) {
        logger.info(
          {
            eventName: 'match:round_result',
            matchId,
            qIndex,
            aiUserId,
            answerCount: committed.answerCount,
            expectedCount: committed.expectedCount,
            questionKind: committed.questionKind,
          },
          'Possession AI answer triggering round resolve'
        );
        await resolveRound(io, matchId, qIndex, false);
      }
    } catch (error) {
      logger.warn({ error, eventName: 'possession_ai_answer', matchId, qIndex }, 'Possession AI answer failed');
    }
  }

  function clearAiMaps(matchId: string): void {
    aiUserIdByMatch.delete(matchId);
    aiSettingsForMatch.delete(matchId);
    persistentModelByMatch.delete(matchId);
    for (const key of questionStatsByKey.keys()) {
      if (key.startsWith(`${matchId}:`)) questionStatsByKey.delete(key);
    }
  }

  function clearAllAiMaps(): void {
    aiUserIdByMatch.clear();
    aiSettingsForMatch.clear();
    persistentModelByMatch.clear();
    questionStatsByKey.clear();
  }

  return {
    resolveAiUserIdForMatch,
    resolveAiCorrectnessForMatch,
    schedulePossessionAiAnswer,
    runPossessionAiAnswer,
    clearAiAnswerTimer,
    clearAiMaps,
    clearAllAiMaps,
  };
}
