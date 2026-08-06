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
    expect(wlStepPoints('higher_lower', true, 400)).toBe(30);
    expect(wlStepPoints('mcq', true, 500)).toBe(40);
    expect(wlStepPoints('career_path', true, 0)).toBe(40);
  });

  it('scales down with elapsed time and floors to integers', () => {
    // 5.5s elapsed → 5s effective remaining → ranked bucket 50 → scaled.
    expect(wlStepPoints('true_false', true, 5500)).toBe(15);
    expect(wlStepPoints('higher_lower', true, 5500)).toBe(15);
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

describe('wlConfigFrom legacy snapshots', () => {
  it('accepts pre-PR5 configs lacking spectator_delay_ms without wiping timings', async () => {
    const { wlConfigFrom } = await import('../../src/modules/weekend-league/wl-config.js');
    const legacy = {
      rules_version: 1, launch_edition: true, engine: 'stub', free_entry: true,
      qp_target: 200, question_time_ms: 1234, dispatch_lead_ms: 0,
      break_ms: 2000, checkin_window_ms: 60000,
    };
    const parsed = wlConfigFrom(legacy);
    expect(parsed.question_time_ms).toBe(1234);
    expect(parsed.spectator_delay_ms).toBe(30_000);
  });
});

describe('wlBuildLadder', () => {
  it('keeps roughly the product shape at the design field of 600', () => {
    // Continuity across field sizes is worth more than hitting 200 exactly —
    // the previous exact-200 branch jumped 80 -> 49 between 146 and 147.
    const [a1, a2, a3] = wlBuildLadder(600);
    expect(a1).toBeGreaterThanOrEqual(195);
    expect(a1).toBeLessThanOrEqual(210);
    expect(a2).toBe(100);
    expect(a3).toBe(24);
  });

  it.each([
    [2, [2, 2, 2]],
    [3, [3, 3, 3]],
    // Tiny fields cannot produce three cuts ending at 24 — the final target
    // drops just enough that every game still eliminates someone.
    [25, [24, 23, 22]],
    [26, [25, 24, 23]],
    [27, [26, 25, 24]],
    // Mid fields spread the reduction so games 2-3 are not dead air.
    [54, [41, 31, 24]],
    [100, [62, 39, 24]],
  ])('field %i → %j', (field, expected) => {
    expect(wlBuildLadder(field)).toEqual(expected);
  });

  it('cuts in EVERY game once the field is big enough to allow it', () => {
    for (let n = 4; n <= 1200; n += 1) {
      const [a1, a2, a3] = wlBuildLadder(n);
      expect(a1).toBeLessThan(n);
      expect(a2).toBeLessThan(a1);
      expect(a3).toBeLessThan(a2);
      expect(a3).toBeGreaterThanOrEqual(1);
      expect(a3).toBeLessThanOrEqual(24);
    }
  });

  it('is monotonic — one extra entrant never swings a cut', () => {
    // The old two-branch ladder jumped 80 -> 49 between fields 146 and 147.
    for (let n = 5; n <= 2000; n += 1) {
      const prev = wlBuildLadder(n - 1);
      const cur = wlBuildLadder(n);
      expect(cur[0]).toBeGreaterThanOrEqual(prev[0]);
      expect(cur[1]).toBeGreaterThanOrEqual(prev[1]);
    }
  });

  it('ends at exactly 24 finalists whenever the field can support it', () => {
    for (let n = 27; n <= 1200; n += 1) {
      expect(wlBuildLadder(n)[2]).toBe(24);
    }
  });

  it('never grows the field and stays non-increasing at any size', () => {
    for (let n = 0; n <= 1200; n += 1) {
      const [a1, a2, a3] = wlBuildLadder(n);
      expect(a1).toBeLessThanOrEqual(n);
      expect(a2).toBeLessThanOrEqual(a1);
      expect(a3).toBeLessThanOrEqual(a2);
    }
  });
});
