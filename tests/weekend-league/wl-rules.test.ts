import { describe, it, expect } from 'vitest';
import {
  WL_GAME_MAX_POINTS,
  WL_QUESTIONS_PER_ROUND,
  WL_QUESTION_TIME_MS,
  WL_ROUND_ORDER,
  WL_STEP_MAX_POINTS,
  WL_WHO_AM_I_CLUE_POINTS,
  wlBuildLadder,
  wlCompareStanding,
  wlEncodeScore,
  wlStepPoints,
  wlTimeChargeMs,
  wlWhoAmIPoints,
} from '../../src/modules/weekend-league/wl-rules.js';

describe('point tables', () => {
  it('a perfect game scores exactly 1000', () => {
    let total = 0;
    for (const kind of WL_ROUND_ORDER) {
      const steps = WL_QUESTIONS_PER_ROUND[kind];
      if (kind === 'who_am_i') {
        total += WL_WHO_AM_I_CLUE_POINTS[0]! * steps;
      } else {
        total += WL_STEP_MAX_POINTS[kind] * steps;
      }
    }
    expect(total).toBe(WL_GAME_MAX_POINTS);
  });

  it('instant correct answers earn the step max (grace window)', () => {
    expect(wlStepPoints('true_false', true, 0)).toBe(30);
    expect(wlStepPoints('higher_lower', true, 400)).toBe(50);
    expect(wlStepPoints('mcq', true, 500)).toBe(40);
    expect(wlStepPoints('career_path', true, 0)).toBe(40);
  });

  it('scales down with elapsed time and floors to integers', () => {
    // 5.5s elapsed → 5s effective remaining → ranked bucket 50 → scaled.
    expect(wlStepPoints('true_false', true, 5500)).toBe(15);
    expect(wlStepPoints('higher_lower', true, 5500)).toBe(25);
    expect(wlStepPoints('mcq', true, 5500)).toBe(20);
  });

  it('wrong answers score zero at any speed', () => {
    expect(wlStepPoints('mcq', false, 0)).toBe(0);
    expect(wlStepPoints('true_false', false, 9000)).toBe(0);
  });

  it('deadline-edge answers score the floor bucket, never negative', () => {
    const atDeadline = wlStepPoints('mcq', true, WL_QUESTION_TIME_MS);
    expect(atDeadline).toBeGreaterThanOrEqual(0);
    expect(atDeadline).toBeLessThanOrEqual(WL_STEP_MAX_POINTS.mcq);
  });

  it('who-am-i scores by clue index and clamps out-of-range indexes', () => {
    expect(wlWhoAmIPoints(true, 0)).toBe(300);
    expect(wlWhoAmIPoints(true, 4)).toBe(60);
    expect(wlWhoAmIPoints(true, 99)).toBe(60);
    expect(wlWhoAmIPoints(true, -1)).toBe(300);
    expect(wlWhoAmIPoints(false, 0)).toBe(0);
  });
});

describe('time charge', () => {
  it('missed steps charge the full clock; answered steps their elapsed', () => {
    expect(wlTimeChargeMs(false, 0)).toBe(WL_QUESTION_TIME_MS);
    expect(wlTimeChargeMs(true, 3200)).toBe(3200);
    expect(wlTimeChargeMs(true, -5)).toBe(0);
    expect(wlTimeChargeMs(true, 60_000)).toBe(WL_QUESTION_TIME_MS);
  });

  it('a fast wrong answer never ranks below a no-show at equal points', () => {
    const wrong = { points: 0, timeMsTotal: wlTimeChargeMs(true, 1500), userId: 'b' };
    const absent = { points: 0, timeMsTotal: wlTimeChargeMs(false, 0), userId: 'a' };
    expect(wlCompareStanding(wrong, absent)).toBeLessThan(0);
  });
});

describe('score encoding + comparator', () => {
  it('points dominate time', () => {
    expect(wlEncodeScore(500, 200_000)).toBeGreaterThan(wlEncodeScore(499, 0));
  });

  it('lower cumulative time wins at equal points', () => {
    expect(wlEncodeScore(500, 100_000)).toBeGreaterThan(wlEncodeScore(500, 100_001));
  });

  it('one point beats ANY time advantage (encoding-scale regression)', () => {
    // A zero-time player must never outrank a player with one more point,
    // even at the encoding's time ceiling.
    expect(wlEncodeScore(500, 99_999_999)).toBeGreaterThan(wlEncodeScore(499, 0));
    expect(wlEncodeScore(1, 99_999_999)).toBeGreaterThan(wlEncodeScore(0, 0));
  });

  it('stays inside the 53-bit exact double range', () => {
    expect(wlEncodeScore(1000, 0)).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(wlEncodeScore(1000, 0))).toBe(true);
  });

  it('comparator is a strict total order: points desc, time asc, userId asc', () => {
    const rows = [
      { points: 100, timeMsTotal: 50, userId: 'c' },
      { points: 100, timeMsTotal: 50, userId: 'a' },
      { points: 100, timeMsTotal: 40, userId: 'z' },
      { points: 200, timeMsTotal: 999, userId: 'q' },
    ];
    const sorted = [...rows].sort(wlCompareStanding);
    expect(sorted.map((r) => r.userId)).toEqual(['q', 'z', 'a', 'c']);
  });
});

describe('wlBuildLadder', () => {
  it('matches the product ladder at 600', () => {
    expect(wlBuildLadder(600)).toEqual([200, 100, 24]);
  });

  it.each([
    [2, [2, 2, 2]],
    [23, [23, 23, 23]],
    [24, [24, 24, 24]],
    [25, [24, 24, 24]],
    [99, [33, 24, 24]],
    [100, [33, 24, 24]],
    [101, [34, 24, 24]],
    [599, [200, 100, 24]],
    [600, [200, 100, 24]],
  ])('field %i → %j', (field, expected) => {
    expect(wlBuildLadder(field)).toEqual(expected);
  });

  it('is non-increasing, ends at min(field, 24), never grows the field', () => {
    for (let n = 0; n <= 700; n += 1) {
      const [a1, a2, a3] = wlBuildLadder(n);
      expect(a1).toBeLessThanOrEqual(n);
      expect(a2).toBeLessThanOrEqual(a1);
      expect(a3).toBeLessThanOrEqual(a2);
      expect(a3).toBe(Math.min(n, 24));
    }
  });
});
