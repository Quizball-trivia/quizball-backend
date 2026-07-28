import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBotModelParams, type BotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import type { ScopeStat } from '../../src/modules/bots/calibration/math.js';
import { logit } from '../../src/modules/bots/calibration/math.js';
import {
  HARD_CEILING_ACCURACY,
  HARD_MIN_ANSWER_TIME_MS,
  HARD_PROB_CAP,
  HARD_SKILL_CAP,
  S1_TOP_COHORT_ACCURACY_HOLDOUT,
} from '../../src/modules/bots/calibration/hard-clamps.js';
import {
  aggregateCeiling,
  boundedCategoryTilt,
  decideClueRevealIndex,
  decideCountdownFoundCount,
  decideMcq,
  decidePutInOrderCorrectCount,
  effectiveProbCap,
  effectiveSkillCap,
  effectiveSkillTheta,
  expectedAggregateAccuracy,
  maxCountdownFoundForCeiling,
  maxPutInOrderMatchedForCeiling,
  minClueIndexForCeiling,
  questionBetaFromStats,
  resolveQuestionStats,
  sampleHistogram,
  solveThetaCeilingBound,
  topCohortSpeedFloorMs,
  type PersistentBotSkillInputs,
  type ResolvedQuestionStats,
} from '../../src/realtime/persistent-bot-gameplay.js';
import { calculateCountdownScore, calculatePutInOrderScore, calculateCluesScore } from '../../src/realtime/scoring.js';

// The frozen calibration artifact (PR4 output), vendored into the repo so tests
// run on CI / any checkout without a home-dir absolute path.
const PARAMS_PATH = resolve(__dirname, 'fixtures/params.json');
const params: BotModelParams = parseBotModelParams(
  JSON.parse(readFileSync(PARAMS_PATH, 'utf8')),
);

// A realistic S1-like beta distribution (accuracies across the full pool) and the
// pinned theta-ceiling bound solved over it — the same the pin builder computes.
const REAL_ACCS: number[] = [];
for (let a = 0.15; a <= 0.95; a += 0.01) REAL_ACCS.push(a);
const REAL_BETAS = REAL_ACCS.map((a) => params.difficultyLink.intercept + params.difficultyLink.slope * logit(a));
const THETA_CEILING = solveThetaCeilingBound(REAL_BETAS, params.ceiling.ceilingAccuracy, effectiveProbCap(params));

function inputs(overrides: Partial<PersistentBotSkillInputs> = {}): PersistentBotSkillInputs {
  return {
    currentRp: 1000,
    personalOffset: 0,
    governorAdjustment: 0,
    categoryAffinities: {},
    dailyFormSeed: '2026-07-28',
    thetaCeilingBound: THETA_CEILING,
    ...overrides,
  };
}

function statsFromAccuracy(acc: number | null, median = 3000, sigma = 0.6): ResolvedQuestionStats {
  return { smoothedAccuracy: acc, medianTimeMs: median, logTimeSigma: sigma };
}

const keys = { botId: 'bot-1', matchId: 'match-1', questionId: 'q-1' };

describe('params fixture + hard code constants', () => {
  it('loads the frozen S1 params and the hard constants line up', () => {
    expect(params.clamps.finalProbCap).toBe(0.93);
    expect(HARD_PROB_CAP).toBe(0.93);
    expect(HARD_SKILL_CAP).toBe(4);
    expect(HARD_MIN_ANSWER_TIME_MS).toBe(600);
    expect(HARD_CEILING_ACCURACY).toBe(0.8631);
    expect(aggregateCeiling(params)).toBeLessThanOrEqual(HARD_CEILING_ACCURACY);
    expect(topCohortSpeedFloorMs(params)).toBe(600); // max(measured 469, hard floor 600)
  });
});

describe('CRITICAL-1 — aggregate ceiling is a HARD runtime bound', () => {
  it('the pinned theta bound keeps expected aggregate over the real mix <= ceiling', () => {
    const cap = effectiveSkillCap(params, THETA_CEILING);
    const agg = expectedAggregateAccuracy(cap, REAL_BETAS, effectiveProbCap(params));
    expect(agg).toBeLessThanOrEqual(params.ceiling.ceilingAccuracy + 1e-6);
  });

  it('worst reachable bot (max RP+offset+tilt+form+noise) aggregates <= ceiling AND below real top cohort', () => {
    // Every skill term maxed; noise favorable. theta_eff is capped POINTWISE at
    // the bound, so the realized aggregate cannot exceed the bound's aggregate.
    const godlike = inputs({
      currentRp: 100000,
      personalOffset: 100,
      governorAdjustment: 100,
      categoryAffinities: { football: 100 },
    });
    let correct = 0;
    const n = REAL_BETAS.length * 40;
    for (let i = 0; i < n; i += 1) {
      const acc = REAL_ACCS[i % REAL_ACCS.length];
      const d = decideMcq(params, godlike, statsFromAccuracy(acc), 'football', { ...keys, questionId: `wq-${i}` });
      correct += d.isCorrect ? 1 : 0;
    }
    const aggregate = correct / n;
    expect(aggregate).toBeLessThanOrEqual(params.ceiling.ceilingAccuracy + 0.01); // sampling slack
    expect(aggregate).toBeLessThan(S1_TOP_COHORT_ACCURACY_HOLDOUT);
  });

  it('solveThetaCeilingBound is monotone and returns the fallback for an empty distribution', () => {
    expect(expectedAggregateAccuracy(1, REAL_BETAS, 0.93))
      .toBeLessThan(expectedAggregateAccuracy(2, REAL_BETAS, 0.93));
    const fallback = solveThetaCeilingBound([], params.ceiling.ceilingAccuracy, 0.93);
    expect(fallback).toBeGreaterThan(0);
    expect(fallback).toBeLessThanOrEqual(HARD_SKILL_CAP);
  });
});

describe('CRITICAL-2 — clamps are immutable code constants applied last', () => {
  it('a params row that tries to LOOSEN a clamp is REJECTED at load', () => {
    const bad = JSON.parse(readFileSync(PARAMS_PATH, 'utf8'));
    bad.clamps.finalProbCap = 1; // > HARD_PROB_CAP
    expect(() => parseBotModelParams(bad)).toThrow();

    const bad2 = JSON.parse(readFileSync(PARAMS_PATH, 'utf8'));
    bad2.clamps.skillCap = 99; // > HARD_SKILL_CAP
    expect(() => parseBotModelParams(bad2)).toThrow();

    const bad3 = JSON.parse(readFileSync(PARAMS_PATH, 'utf8'));
    bad3.clamps.minAnswerTimeMs = 0; // < HARD_MIN_ANSWER_TIME_MS
    expect(() => parseBotModelParams(bad3)).toThrow();

    const bad4 = JSON.parse(readFileSync(PARAMS_PATH, 'utf8'));
    bad4.ceiling.ceilingAccuracy = 0.99; // > HARD_CEILING_ACCURACY
    expect(() => parseBotModelParams(bad4)).toThrow();

    const bad5 = JSON.parse(readFileSync(PARAMS_PATH, 'utf8'));
    bad5.difficultyLink.slope = 0.5; // non-negative slope inverts difficulty
    expect(() => parseBotModelParams(bad5)).toThrow();
  });

  it('runtime clamps take the STRICTER of params vs code (defence in depth)', () => {
    // Even a hand-built params object with looser clamps (bypassing the schema)
    // cannot loosen the effective caps at runtime.
    const loose = { ...params, clamps: { finalProbCap: 1, skillCap: 100, minAnswerTimeMs: 0 } } as BotModelParams;
    expect(effectiveProbCap(loose)).toBe(HARD_PROB_CAP);
    expect(effectiveSkillCap(loose, HARD_SKILL_CAP)).toBe(HARD_SKILL_CAP);
    const d = decideMcq(loose, inputs({ thetaCeilingBound: HARD_SKILL_CAP }), statsFromAccuracy(0.99), null, keys);
    expect(d.pCorrect).toBeLessThanOrEqual(HARD_PROB_CAP + 1e-9);
  });

  it('the skill cap is applied AFTER tilt/form/noise (nothing escapes it)', () => {
    const cap = 1.0;
    // base already at cap, plus large positive tilt+form+noise → still clamped to cap.
    expect(effectiveSkillTheta(1.0, 0.6, 0.25, 5.0, cap)).toBe(cap);
    expect(effectiveSkillTheta(-1.0, -0.6, -0.25, -5.0, cap)).toBe(-cap);
  });
});

describe('monotonicity — expected pCorrect non-increasing in difficulty at fixed affinity', () => {
  // Average out the per-question noise by sampling many questionIds per difficulty.
  function meanP(acc: number, categorySlug: string | null, affKey?: string): number {
    let s = 0;
    const n = 400;
    const inp = affKey ? inputs({ categoryAffinities: { [affKey]: 0.6 } }) : inputs();
    for (let i = 0; i < n; i += 1) {
      s += decideMcq(params, inp, statsFromAccuracy(acc), categorySlug, { ...keys, questionId: `mq-${acc}-${i}` }).pCorrect;
    }
    return s / n;
  }

  it('mean pCorrect decreases as accuracy falls (harder)', () => {
    const accs = [0.95, 0.8, 0.65, 0.5, 0.35, 0.2, 0.1];
    let prev = Infinity;
    for (const acc of accs) {
      const m = meanP(acc, null);
      expect(m).toBeLessThanOrEqual(prev + 5e-3);
      prev = m;
    }
  });

  it('bounded tilt cannot reverse the EXTREMES (trivial ~always right, brutal ~near floor)', () => {
    // Strong-affinity bot on a trivial question still ~aces; weak-affinity bot on a
    // brutal question still ~misses. The tilt only reorders mid-range (realistic).
    const trivialStrong = meanP(0.97, 'x', 'x');
    const brutalWeak = decideMcq(
      params,
      inputs({ categoryAffinities: { x: -0.6 }, currentRp: 300 }),
      statsFromAccuracy(0.05),
      'x',
      keys,
    ).pCorrect;
    expect(trivialStrong).toBeGreaterThan(0.7);
    expect(brutalWeak).toBeLessThan(0.5);
  });

  it('betaQ rises as accuracy falls (negative link slope enforced)', () => {
    expect(questionBetaFromStats(params, 0.9)).toBeLessThan(questionBetaFromStats(params, 0.3));
    expect(params.difficultyLink.slope).toBeLessThan(0);
  });
});

describe('speed floor end-to-end', () => {
  it('sampled answer time never dips below the hard floor / measured floor', () => {
    const floor = topCohortSpeedFloorMs(params);
    expect(floor).toBeGreaterThanOrEqual(HARD_MIN_ANSWER_TIME_MS);
    for (let i = 0; i < 200; i += 1) {
      const d = decideMcq(params, inputs(), statsFromAccuracy(0.5, 10, 0.1), null, { ...keys, questionId: `sf-${i}` });
      expect(d.answerTimeMs).toBeGreaterThanOrEqual(floor);
    }
  });
});

describe('determinism + never reads human answer', () => {
  it('same (botId,matchId,questionId,params) => identical decision', () => {
    expect(decideMcq(params, inputs(), statsFromAccuracy(0.6), 'football', keys))
      .toEqual(decideMcq(params, inputs(), statsFromAccuracy(0.6), 'football', keys));
  });
  it('decision is a pure function of inputs (no human-answer parameter)', () => {
    const a = decideMcq(params, inputs(), statsFromAccuracy(0.55), 'trivia', keys);
    const b = decideMcq(params, inputs(), statsFromAccuracy(0.55), 'trivia', keys);
    expect(b).toEqual(a);
  });
});

describe('category tilt bounding', () => {
  it('tilt vanishes at extremes, peaks mid, and is clamped', () => {
    expect(Math.abs(boundedCategoryTilt(0.6, 0))).toBeGreaterThan(Math.abs(boundedCategoryTilt(0.6, 4)));
    expect(Math.abs(boundedCategoryTilt(0.6, 4))).toBeLessThan(0.05);
    expect(boundedCategoryTilt(999, 0)).toBeCloseTo(boundedCategoryTilt(0.6, 0), 9);
  });
});

describe('HIGH — per-format models bypass Bernoulli AND respect the SCORE ceiling', () => {
  const ceilScore = Math.min(aggregateCeiling(params), effectiveProbCap(params)) * 100;

  it('countdown found-count cap keeps the SCORE at/under the ceiling (no 13/14→95 leak)', () => {
    for (const total of [4, 6, 8, 14]) {
      const maxFound = maxCountdownFoundForCeiling(params, total);
      expect(calculateCountdownScore(maxFound, total)).toBeLessThanOrEqual(ceilScore + 1e-9);
      expect(calculateCountdownScore(maxFound + 1, total)).toBeGreaterThan(ceilScore + 1e-9 - 5);
      const drawn = decideCountdownFoundCount(params, inputs(), { '3': 5, '5': 10, '6': 8 }, total, keys);
      expect(calculateCountdownScore(drawn, total)).toBeLessThanOrEqual(ceilScore + 1e-9);
    }
  });

  it('put-in-order matched cap keeps the SCORE at/under the ceiling (no 5/6→100 leak)', () => {
    for (const total of [4, 5, 6]) {
      const maxMatched = maxPutInOrderMatchedForCeiling(params, total);
      expect(calculatePutInOrderScore(maxMatched, total)).toBeLessThanOrEqual(ceilScore + 1e-9);
      const drawn = decidePutInOrderCorrectCount(params, inputs(), { '4': 4, '5': 8, '6': 3 }, total, keys);
      expect(calculatePutInOrderScore(drawn, total)).toBeLessThanOrEqual(ceilScore + 1e-9);
    }
  });

  it('clue reveal-index floor keeps the SCORE at/under the ceiling (no instant-solve 100)', () => {
    const minIdx = minClueIndexForCeiling(params);
    expect(calculateCluesScore(true, minIdx)).toBeLessThanOrEqual(ceilScore + 1e-9);
    const idx = decideClueRevealIndex(params, inputs(), { '0': 10, '1': 5 }, 5, keys);
    expect(idx).toBeGreaterThanOrEqual(minIdx);
    expect(calculateCluesScore(true, idx)).toBeLessThanOrEqual(ceilScore + 1e-9);
  });

  it('per-format decisions are deterministic', () => {
    expect(decidePutInOrderCorrectCount(params, inputs(), { '2': 4, '4': 12 }, 6, keys))
      .toBe(decidePutInOrderCorrectCount(params, inputs(), { '2': 4, '4': 12 }, 6, keys));
  });

  it('sampleHistogram is a proper weighted draw', () => {
    const counts = new Map<number, number>();
    let r = 0;
    for (let i = 0; i < 1000; i += 1) {
      const next = () => ((r = (r + 0.001) % 1), r);
      const s = sampleHistogram({ '0': 1, '1': 3 }, next);
      if (s != null) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    expect((counts.get(1) ?? 0)).toBeGreaterThan(counts.get(0) ?? 0);
  });
});

describe('backoff resolves for a brand-new question with no stats', () => {
  const globalScope: ScopeStat = {
    answersCount: 100000, correctCount: 50000, smoothedAccuracy: 0.5,
    timingSamples: 100000, medianTimeMs: 1184, logTimeSigma: 0.72,
  };
  it('falls back to global then produces a bounded decision', () => {
    const resolved = resolveQuestionStats(null, null, null, globalScope);
    expect(resolved.smoothedAccuracy).toBe(0.5);
    const d = decideMcq(params, inputs(), resolved, null, keys);
    expect(d.pCorrect).toBeGreaterThan(0);
    expect(d.pCorrect).toBeLessThanOrEqual(effectiveProbCap(params));
  });
  it('null accuracy => beta 0, still bounded, floored time', () => {
    const d = decideMcq(params, inputs(), { smoothedAccuracy: null, medianTimeMs: null, logTimeSigma: null }, null, keys);
    expect(Number.isFinite(d.pCorrect)).toBe(true);
    expect(d.answerTimeMs).toBeGreaterThanOrEqual(topCohortSpeedFloorMs(params));
  });
});
