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
 * AGGREGATE-CEILING GUARANTEE (redesigned per Sol's ceiling-math pass): the ONLY
 * distribution-independent bound on aggregate accuracy is the per-question
 * probability cap. So the hard cap (HARD_PROB_CAP) is set to the frozen ceiling
 * itself — the worst reachable aggregate over ANY mix (incl. an all-easy draft)
 * equals the ceiling (86.31%), below the real top cohort (90.31%). The
 * theta-ceiling solver is an ADDITIONAL tightening for the EXPECTED aggregate
 * over the real mix (a nicety), NOT the safety guarantee. The win-rate governor
 * (PR9) is the closed loop that steers actual win-rate into the 40-45% band.
 *
 * Hard clamps (code constants, params can only tighten): final per-question
 * probability ≤ HARD_PROB_CAP; effective skill (theta) bounded by the
 * inversion-guarded effective cap; answer times floored by HARD_MIN_ANSWER_TIME_MS
 * and the top-cohort speed floor.
 */

import type { BotModelParams } from '../modules/bots/calibration/params-schema.js';
import { evalFCurve, logit, resolveBackoff, sigmoid, type ScopeStat } from '../modules/bots/calibration/math.js';
import {
  HARD_MIN_ANSWER_TIME_MS,
  HARD_PROB_CAP,
  HARD_SKILL_CAP,
  HARD_THETA_CEILING_FALLBACK,
} from '../modules/bots/calibration/hard-clamps.js';
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
  /**
   * Ceiling-derived theta bound, solved at match creation over the real
   * difficulty distribution (or the frozen fallback when the stats table was
   * empty). Effective theta is capped at min(HARD_SKILL_CAP, paramsSkillCap,
   * this) so the aggregate cannot exceed the frozen ceiling. Pinned per match.
   */
  thetaCeilingBound: number;
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
 * The question-independent base skill BEFORE the effective-theta cap:
 * f(currentRp) + personalOffset + governor. This is intentionally NOT capped
 * here — category tilt, daily form and per-question noise are added on top and
 * the cap is applied ONCE to the final effective theta (effectiveSkillTheta).
 * Capping here would let the later terms escape the cap (the be#175 bug).
 */
export function baseSkillTheta(params: BotModelParams, inputs: PersistentBotSkillInputs): number {
  const fromRp = evalFCurve(params.fCurve, inputs.currentRp);
  return fromRp + inputs.personalOffset + inputs.governorAdjustment;
}

/**
 * The immutable upper bound on effective theta. It is the MOST RESTRICTIVE of:
 *   - HARD_SKILL_CAP (code constant),
 *   - params.clamps.skillCap (can only be stricter — schema-bounded ≤ HARD),
 *   - the ceiling-derived theta bound pinned at match creation (thetaCeilingBound):
 *     a tightening for the EXPECTED aggregate over the real mix (NOT the safety
 *     guarantee — that is the per-question cap; §1.5 / hard-clamps.ts).
 *
 * INVERSION GUARD (Sol Critical-2): the result is floored at 0. A pathologically
 * small ceiling drives the solver to a large-NEGATIVE thetaCeilingBound; without
 * the max(0, …) the cap would go negative and clamp(theta, -cap, cap) would swap
 * its bounds and RAISE skill. With the floor, a stricter ceiling can only pin the
 * cap DOWN to 0 (theta forced to 0 → chance-level), never invert it upward.
 */
export function effectiveSkillCap(params: BotModelParams, thetaCeilingBound: number): number {
  return Math.max(0, Math.min(HARD_SKILL_CAP, params.clamps.skillCap, thetaCeilingBound));
}

/**
 * Final effective theta for ONE decision: base + bounded category tilt + daily
 * form + per-question noise, then clamped ONCE to +/- effectiveSkillCap. `cap` is
 * always ≥ 0 (effectiveSkillCap floors it), so the clamp bounds never invert.
 */
export function effectiveSkillTheta(
  base: number,
  tilt: number,
  dailyForm: number,
  matchNoise: number,
  cap: number,
): number {
  const safeCap = Math.max(0, cap); // defence in depth: bounds can never invert
  const theta = base + tilt + dailyForm + matchNoise;
  return clamp(theta, -safeCap, safeCap);
}

/** The effective per-question probability cap: params can only make it stricter. */
export function effectiveProbCap(params: BotModelParams): number {
  return Math.min(HARD_PROB_CAP, params.clamps.finalProbCap);
}

/** The effective minimum answer time: params can only make it stricter (larger). */
export function effectiveMinAnswerTimeMs(params: BotModelParams): number {
  return Math.max(HARD_MIN_ANSWER_TIME_MS, params.clamps.minAnswerTimeMs);
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
 * Expected aggregate accuracy of a bot with a FIXED effective theta over a set
 * of question difficulties (betas), with the per-question probability cap
 * applied. Monotonically non-decreasing in theta (used to solve the ceiling
 * bound). betas may be empty → falls back to a single beta=0.
 */
export function expectedAggregateAccuracy(theta: number, betas: readonly number[], probCap: number): number {
  const bs = betas.length > 0 ? betas : [0];
  let s = 0;
  for (const b of bs) s += Math.min(sigmoid(theta - b), probCap);
  return s / bs.length;
}

/**
 * Solve the ceiling-derived theta bound: the LARGEST theta whose expected
 * aggregate accuracy over `betas` stays at/under `ceiling`. Bisection is valid
 * because expectedAggregateAccuracy is monotonic in theta. When `betas` is empty
 * (fresh DB, no question_stats), returns the conservative frozen fallback so the
 * bound is never accidentally loose. The result is additionally never allowed
 * above HARD_SKILL_CAP (it is only ever a tightening).
 *
 * This is computed ONCE at match creation and pinned; the noise/tilt/form terms
 * are then bounded POINTWISE at this value per decision, so the realized
 * aggregate is guaranteed ≤ ceiling regardless of the noise distribution.
 */
export function solveThetaCeilingBound(
  betas: readonly number[],
  ceiling: number,
  probCap: number,
): number {
  if (betas.length === 0) return Math.min(HARD_THETA_CEILING_FALLBACK, HARD_SKILL_CAP);
  // The capped sigmoid tops out at probCap; if even a very high theta cannot
  // reach the ceiling (ceiling >= probCap over an all-easy mix), the bound is
  // the hard skill cap (no ceiling pressure). Otherwise bisect.
  let lo = -HARD_SKILL_CAP;
  let hi = HARD_SKILL_CAP;
  if (expectedAggregateAccuracy(hi, betas, probCap) <= ceiling) return hi;
  if (expectedAggregateAccuracy(lo, betas, probCap) > ceiling) return lo;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (expectedAggregateAccuracy(mid, betas, probCap) <= ceiling) lo = mid;
    else hi = mid;
  }
  return lo; // largest theta known to satisfy the constraint
}

/**
 * Decide a Bernoulli (multiple-choice) question outcome for a persistent bot.
 * P(correct) = min(sigmoid(theta_eff - beta_q), effectiveProbCap). theta_eff =
 * base + boundedCategoryTilt + dailyForm + matchNoise, then clamped ONCE to
 * +/- effectiveSkillCap — the cap is applied AFTER every term so nothing escapes
 * it. The DISTRIBUTION-INDEPENDENT aggregate guarantee is effectiveProbCap
 * (= the frozen ceiling): since every P(correct) ≤ effectiveProbCap, the
 * aggregate over ANY question mix ≤ effectiveProbCap = ceiling. The theta bound
 * only further tightens the EXPECTED aggregate over the real mix.
 *
 * Monotonicity: the EXPECTED (over noise) pCorrect is non-increasing in beta_q
 * for fixed affinity — the direct −beta_q term dominates the tilt's bounded,
 * middle-weighted beta dependence. Individual noisy draws are independent (a bot
 * can miss an easy question / land a hard one, like a real player); the tilt is
 * bounded so it can only reorder MID-range difficulties, never the extremes
 * (a trivial question stays ~always right, a brutal one ~always wrong).
 *
 * NEVER reads the human's answer — a pure function of params, inputs, stats, and
 * the (bot,match,question) seed.
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

  const cap = effectiveSkillCap(params, inputs.thetaCeilingBound);
  const thetaEffective = effectiveSkillTheta(base, tilt, dailyForm, matchNoise, cap);
  const rawP = sigmoid(thetaEffective - betaQ);
  const pCorrect = clamp(rawP, 0, effectiveProbCap(params));

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

  // Floor by the hard code minimum AND the measured top-cohort speed floor.
  const speedFloorMs = topCohortSpeedFloorMs(params);
  return Math.round(Math.max(sampled, effectiveMinAnswerTimeMs(params), speedFloorMs));
}

/**
 * The measured top-cohort speed floor in ms — the fastest the model may ever
 * answer. Uses the smallest percentile timeMs in ceiling.speedFloor (the 10th
 * percentile of the top cohort), so no bot beats the fastest real players.
 */
export function topCohortSpeedFloorMs(params: BotModelParams): number {
  const floors = params.ceiling.speedFloor;
  const measured = floors.length === 0
    ? effectiveMinAnswerTimeMs(params)
    : floors.reduce((min, f) => Math.min(min, f.timeMs), Infinity);
  // Never below the hard code floor, even if the measured floor is somehow lower.
  return Math.max(measured, HARD_MIN_ANSWER_TIME_MS);
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

/**
 * The maximum normalized SCORE (0..1) a special-format answer may earn — the
 * frozen aggregate ceiling. The per-format caps below translate this into a
 * count/index cap that respects how scoring.ts converts counts → points (e.g.
 * put-in-order 20 pts/position capped at 100, countdown 5-pt buckets), so a bot
 * can't defeat the ceiling via rounding (13/14 → 95) or a low denominator
 * (5/6 → 100).
 */
function ceilingScoreFraction(params: BotModelParams): number {
  return Math.min(aggregateCeiling(params), effectiveProbCap(params));
}

/**
 * Skill-scaled fraction in [0,1] for the no-distribution fallback, using the
 * CAPPED effective skill (thetaCeilingBound applies to formats too) so the
 * fallback can't exceed the ceiling either. Deterministic (no noise term — a
 * distribution-free fallback keeps the mean).
 */
function cappedSkillFraction(params: BotModelParams, inputs: PersistentBotSkillInputs): number {
  const cap = effectiveSkillCap(params, inputs.thetaCeilingBound);
  const skill = clamp(baseSkillTheta(params, inputs), -cap, cap);
  return clamp(sigmoid(skill), 0, 1);
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
 * Countdown SCORE (5-pt buckets) for a found-count, mirroring
 * calculateCountdownScore without importing it (keeps this module IO/dep-free).
 */
function countdownScore(found: number, total: number): number {
  if (total <= 0) return 0;
  const raw = (clamp(found, 0, total) / total) * 100;
  return clamp(Math.round(raw / 5) * 5, 0, 100);
}

/**
 * A seeded Bernoulli success gate at probability p, keyed independently so it is
 * reproducible per (bot,match,question,subkey). Used by the coarse all-or-nothing
 * format cases: when even the SMALLEST nonzero score already exceeds the ceiling
 * (1-group countdown → 100, 1-clue → 100), the bot must sometimes FAIL so the
 * expected SCORE distribution stays ≤ the ceiling — never a deterministic 100.
 */
function ceilingSuccessGate(
  params: BotModelParams,
  keys: { botId: string; matchId: string; questionId: string },
  subkey: string,
): boolean {
  const next = seededStream(`${keys.botId}:${keys.matchId}:${keys.questionId}:${subkey}:gate:${params.source.batchId}`);
  return next() < ceilingScoreFraction(params);
}

/**
 * Countdown: pick a found-count from the calibrated distribution (or a
 * skill-scaled fallback), then bound it so the resulting SCORE respects the
 * ceiling. When the question is so coarse that ANY found group already scores
 * above the ceiling (e.g. a single group → 100 pts), the bot succeeds only with
 * probability = the ceiling fraction (else finds 0) — so its expected score
 * equals the ceiling instead of a guaranteed 100.
 */
export function decideCountdownFoundCount(
  params: BotModelParams,
  inputs: PersistentBotSkillInputs,
  foundCountDistribution: Record<string, number> | undefined,
  totalGroups: number,
  keys: { botId: string; matchId: string; questionId: string },
): number {
  const total = Math.max(1, totalGroups);
  const maxFound = maxCountdownFoundForCeiling(params, totalGroups);
  if (maxFound === 0) {
    // Coarse all-or-nothing: even 1 found exceeds the ceiling. Gate success.
    return ceilingSuccessGate(params, keys, 'countdown') ? total : 0;
  }
  const next = seededStream(`${keys.botId}:${keys.matchId}:${keys.questionId}:countdown:${params.source.batchId}`);
  let found: number;
  if (foundCountDistribution && Object.keys(foundCountDistribution).length > 0) {
    found = sampleHistogram(foundCountDistribution, next) ?? 0;
  } else {
    found = Math.round(total * cappedSkillFraction(params, inputs));
  }
  return clamp(found, 0, maxFound);
}

/**
 * The largest countdown found-count whose SCORE stays at/under the ceiling.
 * Returns 0 when even one found group exceeds the ceiling (coarse case) — the
 * caller then applies the success gate rather than zeroing deterministically.
 */
export function maxCountdownFoundForCeiling(params: BotModelParams, totalGroups: number): number {
  const maxScore = ceilingScoreFraction(params) * 100;
  const total = Math.max(1, totalGroups);
  let best = 0;
  for (let f = 0; f <= total; f += 1) {
    if (countdownScore(f, total) <= maxScore + 1e-9) best = f;
    else break;
  }
  return best;
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
    count = Math.round(totalItems * cappedSkillFraction(params, inputs));
  }
  return clamp(count, 0, maxPutInOrderMatchedForCeiling(params, totalItems));
}

/**
 * The largest put-in-order matched-position count whose SCORE (20 pts/position,
 * capped 100, via calculatePutInOrderScore) stays at/under the ceiling. This is
 * what stops 5/6 → 100 pts from defeating a raw-fraction cap.
 */
export function maxPutInOrderMatchedForCeiling(params: BotModelParams, totalItems: number): number {
  const maxScore = ceilingScoreFraction(params) * 100;
  const total = Math.max(0, totalItems);
  let best = 0;
  for (let m = 0; m <= total; m += 1) {
    const score = Math.min(m * 20, 100);
    if (score <= maxScore + 1e-9) best = m;
    else break;
  }
  // With the 20-pt/position step and a ≥50% ceiling, m=1 (→20 pts) always passes
  // for totalItems ≥ 1, so `best` is never a false 0 here; full credit is
  // reachable on a 1-item question (score 20 ≤ ceiling). No coarse gate needed.
  return best;
}

/** Clue SCORE mirror of calculateCluesScore (max(20, 100 − index*20), 0 if wrong). */
function clueScore(solved: boolean, index: number): number {
  if (!solved) return 0;
  return Math.max(20, 100 - Math.max(0, Math.floor(index)) * 20);
}

/**
 * Clue chain decision: whether the bot solves, and at which reveal index (0-based;
 * lower = solved from fewer clues = better). Sampled from the calibrated reveal
 * distribution (or a skill-scaled fallback), then bounded so the SCORE respects
 * the ceiling. When even the DEEPEST reveal index still scores above the ceiling
 * (e.g. a single-clue question: only index 0 exists → 100 pts), the bot solves
 * only with probability = the ceiling fraction (else it does not solve, score 0)
 * — so a 1-clue question can never deterministically score 100.
 */
export function decideClue(
  params: BotModelParams,
  inputs: PersistentBotSkillInputs,
  clueRevealIndexDistribution: Record<string, number> | undefined,
  clueCount: number,
  keys: { botId: string; matchId: string; questionId: string },
): { solved: boolean; index: number } {
  const maxIndex = Math.max(0, clueCount - 1);
  const ceilScore = ceilingScoreFraction(params) * 100;

  // If even the deepest reveal (maxIndex) scores above the ceiling, no reveal
  // index is safe — gate the solve so E[score] ≤ ceiling.
  if (clueScore(true, maxIndex) > ceilScore + 1e-9) {
    const solved = ceilingSuccessGate(params, keys, 'clue');
    return { solved, index: maxIndex };
  }

  const next = seededStream(`${keys.botId}:${keys.matchId}:${keys.questionId}:clue:${params.source.batchId}`);
  let index: number;
  if (clueRevealIndexDistribution && Object.keys(clueRevealIndexDistribution).length > 0) {
    index = sampleHistogram(clueRevealIndexDistribution, next) ?? maxIndex;
  } else {
    const frac = clamp(1 - cappedSkillFraction(params, inputs), 0, 1);
    index = Math.round(maxIndex * frac);
  }
  // Floor the reveal index so the resulting SCORE stays at/under the ceiling
  // (index 0 → 100 pts would defeat the cap when 100 > ceiling).
  const minIndex = Math.min(minClueIndexForCeiling(params), maxIndex);
  return { solved: true, index: clamp(index, minIndex, maxIndex) };
}

/**
 * The smallest clue reveal index whose SCORE (calculateCluesScore = max(20,
 * 100 − index*20)) stays at/under the ceiling. Solving-instantly (index 0 →
 * 100) is disallowed when 100 exceeds the ceiling-equivalent score.
 */
export function minClueIndexForCeiling(params: BotModelParams): number {
  const maxScore = ceilingScoreFraction(params) * 100;
  for (let idx = 0; idx <= 4; idx += 1) {
    const score = Math.max(20, 100 - idx * 20);
    if (score <= maxScore + 1e-9) return idx;
  }
  return 4;
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
