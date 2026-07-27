import { describe, it, expect } from 'vitest';
import {
  bayesianSmooth,
  resolveBackoff,
  logNormalTimeStats,
  percentile,
  percentileRankOf,
  buildFCurve,
  evalFCurve,
  isTimeoutBackfill,
  type ScopeStat,
} from '../../src/modules/bots/calibration/math.js';
import { FULL_DURATION_MS } from '../../src/modules/bots/calibration/constants.js';

describe('bayesianSmooth', () => {
  it('returns the prior mean when there are no observations', () => {
    expect(bayesianSmooth(0, 0, 0.6, 20)).toBeCloseTo(0.6, 10);
  });

  it('pulls a sparse observation toward the prior', () => {
    // 1/1 observed, prior 0.5, n0=20 -> (1 + 10) / (1 + 20) = 11/21
    expect(bayesianSmooth(1, 1, 0.5, 20)).toBeCloseTo(11 / 21, 10);
  });

  it('converges to the empirical rate as the sample grows', () => {
    const smoothed = bayesianSmooth(900, 1000, 0.5, 20);
    expect(smoothed).toBeGreaterThan(0.88);
    expect(smoothed).toBeLessThan(0.9); // still slightly shrunk toward 0.5
  });

  it('rejects negative counts', () => {
    expect(() => bayesianSmooth(-1, 1, 0.5)).toThrow();
  });
});

describe('resolveBackoff', () => {
  const stat = (answersCount: number, acc: number): ScopeStat => ({
    answersCount,
    correctCount: Math.round(answersCount * acc),
    smoothedAccuracy: acc,
    medianTimeMs: 5000,
    logTimeSigma: 0.4,
  });
  const global = stat(100000, 0.55);

  it('uses the per-question stat when it has enough sample', () => {
    const r = resolveBackoff(stat(50, 0.7), stat(200, 0.6), stat(1000, 0.58), global, 30);
    expect(r.scope).toBe('question');
    expect(r.stat.smoothedAccuracy).toBe(0.7);
  });

  it('descends to category_type when the question is sparse', () => {
    const r = resolveBackoff(stat(5, 0.7), stat(200, 0.6), stat(1000, 0.58), global, 30);
    expect(r.scope).toBe('category_type');
    expect(r.stat.smoothedAccuracy).toBe(0.6);
  });

  it('descends to type when question and category_type are both sparse', () => {
    const r = resolveBackoff(stat(5, 0.7), stat(10, 0.6), stat(1000, 0.58), global, 30);
    expect(r.scope).toBe('type');
    expect(r.stat.smoothedAccuracy).toBe(0.58);
  });

  it('falls through to global when everything is sparse', () => {
    const r = resolveBackoff(stat(1, 0.7), stat(2, 0.6), stat(3, 0.58), global, 30);
    expect(r.scope).toBe('global');
    expect(r.stat.smoothedAccuracy).toBe(0.55);
  });

  it('treats a null per-question stat as absent', () => {
    const r = resolveBackoff(null, stat(200, 0.6), stat(1000, 0.58), global, 30);
    expect(r.scope).toBe('category_type');
  });
});

describe('logNormalTimeStats', () => {
  it('returns nulls on empty input', () => {
    expect(logNormalTimeStats([])).toEqual({ medianTimeMs: null, logTimeSigma: null, count: 0 });
  });

  it('drops non-positive times', () => {
    const r = logNormalTimeStats([0, -5, 1000, 1000, 1000]);
    expect(r.count).toBe(3);
    expect(r.medianTimeMs).toBe(1000);
  });

  it('computes a median and a positive log-sigma for a spread sample', () => {
    const r = logNormalTimeStats([1000, 2000, 4000, 8000]);
    expect(r.medianTimeMs).toBe(3000);
    expect(r.logTimeSigma).toBeGreaterThan(0);
  });

  it('recovers the sigma of a known log-normal sample within tolerance', () => {
    // exp of an arithmetic sequence in log space -> known ln-sigma
    const logs = [];
    for (let i = 0; i < 500; i += 1) logs.push(Math.log(2000) + (i - 250) * 0.004);
    const times = logs.map((l) => Math.exp(l));
    const r = logNormalTimeStats(times);
    // sample std of an arithmetic sequence with step 0.004 over 500 points
    expect(r.logTimeSigma).toBeGreaterThan(0.5);
    expect(r.logTimeSigma).toBeLessThan(0.62);
  });
});

describe('percentile / percentileRankOf', () => {
  const sorted = [1, 2, 3, 4, 5];
  it('interpolates linearly', () => {
    expect(percentile(sorted, 0.5)).toBe(3);
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 1)).toBe(5);
    expect(percentile(sorted, 0.25)).toBe(2);
  });
  it('mid-ranks ties', () => {
    expect(percentileRankOf([1, 2, 2, 2, 3], 2)).toBeCloseTo((1 + 3 / 2) / 5, 10);
    expect(percentileRankOf(sorted, 5)).toBeCloseTo(0.9, 10);
  });
});

describe('buildFCurve / evalFCurve', () => {
  it('produces a monotonic RP->skill mapping and interpolates between knots', () => {
    const rps = [];
    const skills = [];
    for (let i = 0; i < 100; i += 1) {
      rps.push(1000 + i * 10); // 1000..1990
      skills.push(-2 + i * 0.04); // -2..1.96
    }
    const knots = buildFCurve(rps, skills, [0.05, 0.25, 0.5, 0.75, 0.95]);
    expect(knots).toHaveLength(5);
    for (let i = 1; i < knots.length; i += 1) {
      expect(knots[i].rp).toBeGreaterThan(knots[i - 1].rp);
      expect(knots[i].skill).toBeGreaterThan(knots[i - 1].skill);
    }
    // eval between two knots is between their skills
    const mid = evalFCurve(knots, (knots[1].rp + knots[2].rp) / 2);
    expect(mid).toBeGreaterThan(knots[1].skill);
    expect(mid).toBeLessThan(knots[2].skill);
    // clamps outside the knot range
    expect(evalFCurve(knots, -999)).toBe(knots[0].skill);
    expect(evalFCurve(knots, 999999)).toBe(knots[knots.length - 1].skill);
  });
});

describe('isTimeoutBackfill', () => {
  it('flags a backfilled MCQ (null index, full duration, 0 points, wrong)', () => {
    expect(
      isTimeoutBackfill({ selectedIndex: null, isCorrect: false, pointsEarned: 0, timeMs: FULL_DURATION_MS.multipleChoice, kind: 'multipleChoice' }),
    ).toBe(true);
  });

  it('does NOT flag a real wrong buzzer-beater MCQ (non-null index at full duration)', () => {
    expect(
      isTimeoutBackfill({ selectedIndex: 2, isCorrect: false, pointsEarned: 0, timeMs: FULL_DURATION_MS.multipleChoice, kind: 'multipleChoice' }),
    ).toBe(false);
  });

  it('does NOT flag a real correct slow answer', () => {
    expect(
      isTimeoutBackfill({ selectedIndex: 1, isCorrect: true, pointsEarned: 70, timeMs: FULL_DURATION_MS.multipleChoice, kind: 'multipleChoice' }),
    ).toBe(false);
  });

  it('flags backfilled special formats at their own full durations', () => {
    expect(isTimeoutBackfill({ selectedIndex: null, isCorrect: false, pointsEarned: 0, timeMs: FULL_DURATION_MS.countdown, kind: 'countdown' })).toBe(true);
    expect(isTimeoutBackfill({ selectedIndex: null, isCorrect: false, pointsEarned: 0, timeMs: FULL_DURATION_MS.putInOrder, kind: 'putInOrder' })).toBe(true);
    expect(isTimeoutBackfill({ selectedIndex: null, isCorrect: false, pointsEarned: 0, timeMs: FULL_DURATION_MS.clues, kind: 'clues' })).toBe(true);
  });

  it('does NOT flag a null-index answer whose time is below the full duration', () => {
    expect(
      isTimeoutBackfill({ selectedIndex: null, isCorrect: false, pointsEarned: 0, timeMs: 9000, kind: 'multipleChoice' }),
    ).toBe(false);
  });
});
