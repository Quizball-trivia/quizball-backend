/**
 * Pure calibration math — no DB, no IO. Unit-tested in isolation.
 */

import { BACKOFF_MIN_SAMPLE, SMOOTHING_PRIOR_N0 } from './constants.js';

/**
 * Bayesian shrinkage of an observed accuracy toward a prior mean. With n0
 * pseudo-observations at the prior mean:
 *   smoothed = (correct + n0 * priorMean) / (total + n0)
 * A question with few answers is pulled toward priorMean; with many answers the
 * shrinkage vanishes.
 */
export function bayesianSmooth(
  correct: number,
  total: number,
  priorMean: number,
  n0: number = SMOOTHING_PRIOR_N0,
): number {
  if (total < 0 || correct < 0 || n0 < 0) {
    throw new Error('bayesianSmooth: counts must be non-negative');
  }
  return (correct + n0 * priorMean) / (total + n0);
}

export interface ScopeStat {
  /** Bernoulli answers backing the accuracy figure (excludes special formats). */
  answersCount: number;
  correctCount: number;
  smoothedAccuracy: number | null;
  /** Clean-window timing samples — INDEPENDENT of answersCount. */
  timingSamples: number;
  medianTimeMs: number | null;
  logTimeSigma: number | null;
}

export type BackoffScope = 'question' | 'category_type' | 'type' | 'global';

/**
 * Field-level hierarchical backoff. Accuracy and timing are resolved
 * INDEPENDENTLY, each against its own sample count, because a question can have
 * plenty of accuracy answers (pre-window) but zero clean timing samples (or vice
 * versa). Precedence for both: question -> category_type -> type -> global.
 * `global` is the guaranteed floor.
 */
export function resolveBackoff(
  perQuestion: ScopeStat | null,
  categoryType: ScopeStat | null,
  type: ScopeStat | null,
  global: ScopeStat,
  minSample: number = BACKOFF_MIN_SAMPLE,
): {
  accuracyScope: BackoffScope;
  smoothedAccuracy: number | null;
  timingScope: BackoffScope;
  medianTimeMs: number | null;
  logTimeSigma: number | null;
} {
  const chain: Array<{ scope: BackoffScope; stat: ScopeStat | null }> = [
    { scope: 'question', stat: perQuestion },
    { scope: 'category_type', stat: categoryType },
    { scope: 'type', stat: type },
    { scope: 'global', stat: global },
  ];

  let accuracyScope: BackoffScope = 'global';
  let smoothedAccuracy: number | null = global.smoothedAccuracy;
  for (const c of chain) {
    if (c.stat && c.stat.answersCount >= minSample && c.stat.smoothedAccuracy != null) {
      accuracyScope = c.scope;
      smoothedAccuracy = c.stat.smoothedAccuracy;
      break;
    }
  }

  let timingScope: BackoffScope = 'global';
  let medianTimeMs: number | null = global.medianTimeMs;
  let logTimeSigma: number | null = global.logTimeSigma;
  for (const c of chain) {
    if (c.stat && c.stat.timingSamples >= minSample && c.stat.medianTimeMs != null) {
      timingScope = c.scope;
      medianTimeMs = c.stat.medianTimeMs;
      logTimeSigma = c.stat.logTimeSigma;
      break;
    }
  }

  return { accuracyScope, smoothedAccuracy, timingScope, medianTimeMs, logTimeSigma };
}

/** Numerically-safe logit (inverse sigmoid) with clamping. */
export function logit(p: number): number {
  const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(c / (1 - c));
}

/** Ordinary-least-squares y = a + b·x. Returns intercept, slope, and R². */
export function linearFit(xs: readonly number[], ys: readonly number[]): { intercept: number; slope: number; r2: number } {
  const n = xs.length;
  if (n < 2 || n !== ys.length) throw new Error('linearFit: need >= 2 matched points');
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { intercept, slope, r2 };
}

/**
 * Log-normal timing summary from a list of answer times (ms). Returns the
 * median (a robust central value, in ms) and the sigma of ln(time) (spread on
 * the log scale, used to sample realistic bot answer times). Times <= 0 are
 * dropped (they can only be corrupt — real clamped times are >= 0 but a genuine
 * 0 carries no timing information and would break the log).
 */
export function logNormalTimeStats(timesMs: readonly number[]): {
  medianTimeMs: number | null;
  logTimeSigma: number | null;
  count: number;
} {
  const clean = timesMs.filter((t) => Number.isFinite(t) && t > 0);
  if (clean.length === 0) return { medianTimeMs: null, logTimeSigma: null, count: 0 };
  const sorted = [...clean].sort((a, b) => a - b);
  const medianTimeMs = Math.round(percentile(sorted, 0.5));
  if (clean.length < 2) {
    return { medianTimeMs, logTimeSigma: null, count: clean.length };
  }
  const logs = clean.map((t) => Math.log(t));
  const mean = logs.reduce((s, x) => s + x, 0) / logs.length;
  const variance = logs.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (logs.length - 1);
  return { medianTimeMs, logTimeSigma: Math.sqrt(variance), count: clean.length };
}

/**
 * Linear-interpolated percentile of an ALREADY-SORTED ascending array.
 * p in [0,1]. Empty array throws.
 */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) throw new Error('percentile: empty input');
  if (p <= 0) return sortedAsc[0];
  if (p >= 1) return sortedAsc[sortedAsc.length - 1];
  const idx = p * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/** Rank of `value` within a sorted ascending sample, as a fraction in [0,1]. */
export function percentileRankOf(sortedAsc: readonly number[], value: number): number {
  const n = sortedAsc.length;
  if (n === 0) throw new Error('percentileRankOf: empty sample');
  // Count of samples strictly below + half the ties => mid-rank fraction.
  let below = 0;
  let equal = 0;
  for (const s of sortedAsc) {
    if (s < value) below += 1;
    else if (s === value) equal += 1;
  }
  return (below + equal / 2) / n;
}

export interface FCurveKnot {
  rp: number;
  skill: number;
}

/**
 * Build the f(RP) curve knots on a FIXED scale anchored to the S1 latent-skill
 * distribution. For each requested percentile p we read the RP at that
 * percentile of the S1 (placed) RP distribution and the skill at that
 * percentile of the S1 latent-skill distribution, yielding a monotonic
 * RP -> skill mapping. This is deliberately NOT a live S2 percentile mapping.
 */
export function buildFCurve(
  rpsSortedAsc: readonly number[],
  skillsSortedAsc: readonly number[],
  percentiles: readonly number[],
): FCurveKnot[] {
  return percentiles.map((p) => ({
    rp: Math.round(percentile(rpsSortedAsc, p)),
    skill: percentile(skillsSortedAsc, p),
  }));
}

/** Piecewise-linear evaluation of an f(RP) curve at an arbitrary RP. */
export function evalFCurve(knots: readonly FCurveKnot[], rp: number): number {
  if (knots.length === 0) throw new Error('evalFCurve: no knots');
  if (rp <= knots[0].rp) return knots[0].skill;
  const last = knots[knots.length - 1];
  if (rp >= last.rp) return last.skill;
  for (let i = 1; i < knots.length; i += 1) {
    if (rp <= knots[i].rp) {
      const a = knots[i - 1];
      const b = knots[i];
      if (b.rp === a.rp) return b.skill;
      const frac = (rp - a.rp) / (b.rp - a.rp);
      return a.skill + frac * (b.skill - a.skill);
    }
  }
  return last.skill;
}

/** Pearson correlation coefficient (used by tests + fit diagnostics). */
export function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n === 0 || n !== ys.length) throw new Error('pearson: mismatched/empty input');
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

export function rmse(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n === 0 || n !== ys.length) throw new Error('rmse: mismatched/empty input');
  let s = 0;
  for (let i = 0; i < n; i += 1) s += (xs[i] - ys[i]) * (xs[i] - ys[i]);
  return Math.sqrt(s / n);
}

export function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

/** AUC (Mann–Whitney) of predicted probabilities vs binary labels. */
export function rocAuc(predicted: readonly number[], labels: readonly (0 | 1)[]): number {
  const n = predicted.length;
  if (n === 0 || n !== labels.length) throw new Error('rocAuc: mismatched/empty input');
  const pos: number[] = [];
  const neg: number[] = [];
  for (let i = 0; i < n; i += 1) (labels[i] === 1 ? pos : neg).push(predicted[i]);
  if (pos.length === 0 || neg.length === 0) return 0.5;
  // Rank-sum with tie handling.
  const all = predicted.map((p, i) => ({ p, y: labels[i] }));
  all.sort((a, b) => a.p - b.p);
  let rank = 1;
  let i = 0;
  let rankSumPos = 0;
  while (i < all.length) {
    let j = i;
    while (j < all.length && all[j].p === all[i].p) j += 1;
    const avgRank = (rank + (rank + (j - i) - 1)) / 2;
    for (let k = i; k < j; k += 1) if (all[k].y === 1) rankSumPos += avgRank;
    rank += j - i;
    i = j;
  }
  return (rankSumPos - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

/** Reliability (calibration) curve: predicted-bin mean vs observed accuracy. */
export function calibrationCurve(
  predicted: readonly number[],
  labels: readonly (0 | 1)[],
  bins = 10,
): Array<{ binLow: number; binHigh: number; count: number; meanPredicted: number; observed: number }> {
  const out: Array<{ binLow: number; binHigh: number; count: number; meanPredicted: number; observed: number }> = [];
  for (let b = 0; b < bins; b += 1) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    let count = 0;
    let sumP = 0;
    let sumY = 0;
    for (let i = 0; i < predicted.length; i += 1) {
      const p = predicted[i];
      const inBin = b === bins - 1 ? p >= lo && p <= hi : p >= lo && p < hi;
      if (inBin) {
        count += 1;
        sumP += p;
        sumY += labels[i];
      }
    }
    out.push({
      binLow: lo,
      binHigh: hi,
      count,
      meanPredicted: count ? sumP / count : 0,
      observed: count ? sumY / count : 0,
    });
  }
  return out;
}

/**
 * Is a persisted Bernoulli (multiple-choice-kind) answer a timeout backfill?
 * For mcq_single / true_false / input_text the resolver persists a real
 * non-null selected_index for any genuine answer, so a NULL index is the exact,
 * unambiguous backfill marker. This is only valid for the multiple-choice
 * kinds; special formats (countdown/put-in-order/clues) never use this.
 */
export function isBernoulliBackfill(row: { selectedIndex: number | null }): boolean {
  return row.selectedIndex === null;
}
