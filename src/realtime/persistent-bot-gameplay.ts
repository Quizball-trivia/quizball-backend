/**
 * Calibrated gameplay model for PERSISTENT roster bots (PR8, plan §1.4/§1.5).
 *
 * This module is pure and IO-free: given the frozen calibration params, a bot's
 * skill inputs, and a question's difficulty stats, it decides the bot's
 * per-question outcome (correct/incorrect + answer time, or the per-format
 * distribution result). It replaces the temporary difficulty bridge PR7 pinned
 * for persistent bots (correctnessFromAnchor clamped ≤0.75) with the real model.
 *
 * Ephemeral bots do NOT use this path — they keep the existing
 * correctnessFromAnchor / delayProfileFromAnchor derivation in possession-ai.
 *
 * Determinism: every decision is seeded by (botId, matchId, questionId, version)
 * so the same question in the same match always resolves identically, on any
 * replica, independent of how many other RNG draws happened in the match and
 * WITHOUT ever reading the human's submitted answer.
 *
 * Hard clamps (params.clamps + params.ceiling): the final per-question
 * probability can never exceed finalProbCap; effective skill (theta) is bounded
 * by skillCap; sampled answer times are floored by minAnswerTimeMs and the
 * top-cohort speed floor. These are enforced here from the params — a CMS
 * override that widens a tilt/form/governor input can never breach them.
 */

import type { BotModelParams } from '../modules/bots/calibration/params-schema.js';
import { evalFCurve, logit, resolveBackoff, sigmoid, type ScopeStat } from '../modules/bots/calibration/math.js';
import { clamp } from './scoring.js';

/**
 * How far a strong/weak category may tilt effective skill, in theta units. The
 * tilt is applied so it moves the MIDDLE of the difficulty range and vanishes at
 * the extremes (§1.5): a weak-category bot still answers a trivial question, a
 * strong-category bot never aces the hardest. Bounded and symmetric.
 */
export const MAX_CATEGORY_TILT_THETA = 0.6;

/** Daily-form swing (theta) and per-match noise sigma (theta). Bounded, small. */
export const MAX_DAILY_FORM_THETA = 0.25;
export const MATCH_NOISE_SIGMA_THETA = 0.35;

/** Backoff sample floor mirrors calibration BACKOFF_MIN_SAMPLE (constants.ts). */
const BACKOFF_MIN_SAMPLE = 30;

/**
 * The per-bot, per-match inputs that make up a bot's effective skill. All of
 * these are known at match creation and pinned into ranked_context so a live
 * bot is immune to a mid-match params/profile refresh (§1.7).
 */
export interface PersistentBotSkillInputs {
  /** The bot's current ranked RP (drives f(RP)). */
  currentRp: number;
  /** synthetic_player_profiles.base_skill — the hidden personal offset (theta). */
  personalOffset: number;
  /** Governor adjustment (theta); 0 until PR9 wires the governor. */
  governorAdjustment: number;
  /** category slug -> bounded affinity offset (raw, pre-tilt-bounding). */
  categoryAffinities: Record<string, number>;
  /** Deterministic daily-form seed component (a Georgia-day string is fine). */
  dailyFormSeed: string;
}

/**
 * Per-question difficulty stats resolved from question_stats (+ backoff). The
 * caller resolves the backoff chain (question -> category_type -> type ->
 * global) and passes the winning ScopeStats; this module needs only the
 * smoothed accuracy (for the difficulty link) and the timing summary.
 */
export interface ResolvedQuestionStats {
  smoothedAccuracy: number | null;
  medianTimeMs: number | null;
  logTimeSigma: number | null;
}

export interface McqDecision {
  isCorrect: boolean;
  /** Final clamped P(correct) used for the draw (for logging/telemetry). */
  pCorrect: number;
  /** Sampled answer time in ms, floored by the clamps. */
  answerTimeMs: number;
}

/**
 * A tiny, self-contained seeded PRNG (mulberry32) keyed by a string. Kept local
 * so a persistent-bot decision derives its OWN stream from (botId, matchId,
 * questionId, version) and is reproducible regardless of the ambient match RNG.
 */
function seededStream(key: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller standard normal from a seeded uniform stream. */
function standardNormal(next: () => number): number {
  const u1 = Math.max(next(), 1e-12);
  const u2 = next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Bounded category tilt that acts on the MIDDLE of the difficulty range and
 * vanishes at the extremes. `weight` in [0,1] is 1 at mid-difficulty (beta ≈ 0)
 * and 0 at the extremes; multiplying the (bounded) affinity by it guarantees
 * monotonicity-in-difficulty is preserved: the tilt can never re-order a trivial
 * vs a hard question. betaQ is the question difficulty on the logit scale.
 */
export function boundedCategoryTilt(affinity: number, betaQ: number): number {
  const bounded = clamp(affinity, -MAX_CATEGORY_TILT_THETA, MAX_CATEGORY_TILT_THETA);
  // sech(beta)-like bell centred at beta=0; ~1 near the middle, ->0 at |beta|>>0.
  const weight = 1 / Math.cosh(betaQ);
  return bounded * weight;
}

/**
 * Effective skill (theta) for a bot: f(currentRp) + personalOffset + governor,
 * bounded by the params skill cap. Category tilt / daily form / match noise are
 * added per-question (they depend on the question), so they are NOT included
 * here — this is the question-independent base.
 */
export function baseSkillTheta(params: BotModelParams, inputs: PersistentBotSkillInputs): number {
  const fromRp = evalFCurve(params.fCurve, inputs.currentRp);
  const theta = fromRp + inputs.personalOffset + inputs.governorAdjustment;
  const cap = params.clamps.skillCap;
  return clamp(theta, -cap, cap);
}

/**
 * Question difficulty on the logit scale (beta_q) from smoothed human accuracy,
 * via the frozen difficulty link: beta ≈ intercept + slope * logit(accuracy).
 * A null accuracy (brand-new question with no stats even after backoff) falls
 * back to beta=0 (median difficulty) — the global scope is the guaranteed floor
 * of the resolver, so this only bites when the whole table is empty.
 */
export function questionBetaFromStats(params: BotModelParams, smoothedAccuracy: number | null): number {
  if (smoothedAccuracy == null) return 0;
  return params.difficultyLink.intercept + params.difficultyLink.slope * logit(smoothedAccuracy);
}

/**
 * Decide a Bernoulli (multiple-choice) question outcome for a persistent bot.
 * P(correct) = sigmoid(theta_effective - beta_q), then hard-clamped by
 * finalProbCap. Bounded category tilt, daily form and per-match noise adjust
 * theta_effective but can never push the FINAL probability past the cap.
 * Monotonic in beta_q by construction: none of the theta terms depend on beta
 * except the tilt, which only shrinks toward the middle (never re-orders a
 * trivial vs a hard question). `categorySlug` null skips the tilt entirely.
 *
 * NEVER reads the human's answer — the decision is a function only of the
 * params, the bot's inputs, the question stats, and the (bot,match,question)
 * seed, so it is identical whether computed at question-show or replayed later.
 */
export function decideMcq(
  params: BotModelParams,
  inputs: PersistentBotSkillInputs,
  stats: ResolvedQuestionStats,
  categorySlug: string | null,
  keys: { botId: string; matchId: string; questionId: string },
): McqDecision {
  const next = seededStream(`${keys.botId}:${keys.matchId}:${keys.questionId}:${params.source.batchId}`);

  const base = baseSkillTheta(params, inputs);
  const betaQ = questionBetaFromStats(params, stats.smoothedAccuracy);
  const affinity = categorySlug != null ? (inputs.categoryAffinities[categorySlug] ?? 0) : 0;
  const tilt = boundedCategoryTilt(affinity, betaQ);

  // Daily form: bounded deterministic swing per Georgia-day (a whole-day shift,
  // so it is drawn from a day-scoped stream, not the per-question one).
  const formStream = seededStream(`${keys.botId}:${inputs.dailyFormSeed}`);
  const dailyForm = (formStream() * 2 - 1) * MAX_DAILY_FORM_THETA;
  // Per-match noise: an independent draw so two questions in the same match are
  // not identically shifted, but reproducible for this (bot,match,question).
  const matchNoise = standardNormal(next) * MATCH_NOISE_SIGMA_THETA;

  const thetaEffective = base + tilt + dailyForm + matchNoise;
  const rawP = sigmoid(thetaEffective - betaQ);
  const pCorrect = clamp(rawP, 0, params.clamps.finalProbCap);

  const isCorrect = next() < pCorrect;
  const answerTimeMs = sampleAnswerTimeMs(params, stats, isCorrect, next);
  return { isCorrect, pCorrect, answerTimeMs };
}

/**
 * Sample an answer time (ms) from the question's log-normal timing summary,
 * floored by both clamps.minAnswerTimeMs and the top-cohort speed floor
 * (ceiling.speedFloor / topMedianTimeMs) so a bot is NEVER faster than the
 * measured fastest real cohort. A correct answer trends a touch faster than an
 * incorrect one (humans dwell longer before a miss).
 */
export function sampleAnswerTimeMs(
  params: BotModelParams,
  stats: ResolvedQuestionStats,
  isCorrect: boolean,
  next: () => number,
): number {
  const median = stats.medianTimeMs ?? params.ceiling.topMedianTimeMs ?? 3000;
  const sigma = stats.logTimeSigma ?? params.ceiling.topLogTimeSigma ?? 0.6;
  const mu = Math.log(Math.max(median, 1));
  // Misses dwell ~15% longer on average.
  const dwell = isCorrect ? 0 : 0.15;
  const sampled = Math.exp(mu + dwell + standardNormal(next) * sigma);

  const speedFloorMs = topCohortSpeedFloorMs(params);
  return Math.round(Math.max(sampled, params.clamps.minAnswerTimeMs, speedFloorMs));
}

/**
 * The measured top-cohort speed floor in ms — the fastest the model may ever
 * answer. Uses the smallest percentile timeMs in ceiling.speedFloor (the 10th
 * percentile of the top cohort), so no bot beats the fastest real players.
 */
export function topCohortSpeedFloorMs(params: BotModelParams): number {
  const floors = params.ceiling.speedFloor;
  if (floors.length === 0) return params.clamps.minAnswerTimeMs;
  return floors.reduce((min, f) => Math.min(min, f.timeMs), Infinity);
}

/** The frozen aggregate accuracy ceiling (86.3% for S1) as a code constant. */
export function aggregateCeiling(params: BotModelParams): number {
  return params.ceiling.ceilingAccuracy;
}

// ---------------------------------------------------------------------------
// Per-format models (countdown / put-in-order / clue). These use the calibrated
// format_stats distributions, NOT the Bernoulli path (§1.5). Each returns a
// normalized result the caller maps onto the concrete answer, and each is
// capped so it cannot exceed the top-cohort normalized-score equivalents.
// ---------------------------------------------------------------------------

/** Cap on the normalized special-format score, mirroring finalProbCap. */
function specialScoreCap(params: BotModelParams): number {
  return params.clamps.finalProbCap;
}

/**
 * Sample from an index->count histogram (as stored in format_stats) using a
 * seeded uniform. Returns the sampled integer index. Empty histogram -> null.
 */
export function sampleHistogram(hist: Record<string, number>, next: () => number): number | null {
  const entries = Object.entries(hist)
    .map(([k, v]) => [Number(k), v] as const)
    .filter(([k, v]) => Number.isFinite(k) && v > 0)
    .sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total <= 0) return null;
  let r = next() * total;
  for (const [k, v] of entries) {
    r -= v;
    if (r <= 0) return k;
  }
  return entries[entries.length - 1][0];
}

/**
 * Countdown: pick a found-count from the question's found-count distribution,
 * scaled by the bot's skill (a stronger bot samples toward the upper tail) and
 * capped so its normalized found-fraction can't exceed the top-cohort cap.
 */
export function decideCountdownFoundCount(
  params: BotModelParams,
  inputs: PersistentBotSkillInputs,
  foundCountDistribution: Record<string, number> | undefined,
  totalGroups: number,
  keys: { botId: string; matchId: string; questionId: string },
): number {
  const next = seededStream(`${keys.botId}:${keys.matchId}:${keys.questionId}:countdown:${params.source.batchId}`);
  const capped = Math.max(1, totalGroups);
  let found: number;
  if (foundCountDistribution && Object.keys(foundCountDistribution).length > 0) {
    found = sampleHistogram(foundCountDistribution, next) ?? 0;
  } else {
    // No distribution: fall back to a skill-scaled fraction.
    const skill = baseSkillTheta(params, inputs);
    const frac = clamp(sigmoid(skill) * 0.9, 0, 1);
    found = Math.round(capped * frac);
  }
  const cap = Math.floor(capped * specialScoreCap(params));
  return clamp(found, 0, cap);
}

/**
 * Put-in-order: pick a partial-credit count (how many items placed correctly)
 * from the distribution, capped by the top-cohort normalized cap.
 */
export function decidePutInOrderCorrectCount(
  params: BotModelParams,
  inputs: PersistentBotSkillInputs,
  correctCountDistribution: Record<string, number> | undefined,
  totalItems: number,
  keys: { botId: string; matchId: string; questionId: string },
): number {
  const next = seededStream(`${keys.botId}:${keys.matchId}:${keys.questionId}:pio:${params.source.batchId}`);
  let count: number;
  if (correctCountDistribution && Object.keys(correctCountDistribution).length > 0) {
    count = sampleHistogram(correctCountDistribution, next) ?? 0;
  } else {
    const skill = baseSkillTheta(params, inputs);
    const frac = clamp(sigmoid(skill), 0, 1);
    count = Math.round(totalItems * frac);
  }
  const cap = Math.floor(totalItems * specialScoreCap(params));
  return clamp(count, 0, Math.max(0, Math.min(totalItems, cap)));
}

/**
 * Clue chain: pick a reveal index (0-based; lower = solved from fewer clues =
 * better) from the distribution. A stronger bot skews toward lower indices. No
 * upper cap needed (0 is already the best possible), but a floor keeps the bot
 * from always solving instantly regardless of the human distribution.
 */
export function decideClueRevealIndex(
  params: BotModelParams,
  inputs: PersistentBotSkillInputs,
  clueRevealIndexDistribution: Record<string, number> | undefined,
  clueCount: number,
  keys: { botId: string; matchId: string; questionId: string },
): number {
  const next = seededStream(`${keys.botId}:${keys.matchId}:${keys.questionId}:clue:${params.source.batchId}`);
  const maxIndex = Math.max(0, clueCount - 1);
  let index: number;
  if (clueRevealIndexDistribution && Object.keys(clueRevealIndexDistribution).length > 0) {
    index = sampleHistogram(clueRevealIndexDistribution, next) ?? maxIndex;
  } else {
    const skill = baseSkillTheta(params, inputs);
    const frac = clamp(1 - sigmoid(skill), 0, 1);
    index = Math.round(maxIndex * frac);
  }
  return clamp(index, 0, maxIndex);
}

/**
 * Resolve the per-question difficulty stats from the raw question_stats rows via
 * the shared field-level backoff (question -> category_type -> type -> global).
 * Returned shape feeds decideMcq* and sampleAnswerTimeMs.
 */
export function resolveQuestionStats(
  perQuestion: ScopeStat | null,
  categoryType: ScopeStat | null,
  type: ScopeStat | null,
  global: ScopeStat,
): ResolvedQuestionStats {
  const resolved = resolveBackoff(perQuestion, categoryType, type, global, BACKOFF_MIN_SAMPLE);
  return {
    smoothedAccuracy: resolved.smoothedAccuracy,
    medianTimeMs: resolved.medianTimeMs,
    logTimeSigma: resolved.logTimeSigma,
  };
}
