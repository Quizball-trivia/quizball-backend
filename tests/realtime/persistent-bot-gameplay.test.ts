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
  decideClue,
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
    expect(params.clamps.finalProbCap).toBe(0.93); // artifact value; runtime tightens
    expect(HARD_PROB_CAP).toBe(0.8631); // == the ceiling (distribution-independent guarantee)
    expect(HARD_PROB_CAP).toBe(HARD_CEILING_ACCURACY);
    expect(HARD_SKILL_CAP).toBe(4);
    expect(HARD_MIN_ANSWER_TIME_MS).toBe(600);
    expect(HARD_CEILING_ACCURACY).toBe(0.8631);
    expect(aggregateCeiling(params)).toBeLessThanOrEqual(HARD_CEILING_ACCURACY);
    expect(topCohortSpeedFloorMs(params)).toBe(600); // max(measured 469, hard floor 600)
  });
});

describe('CRITICAL-1 — the per-question cap is the DISTRIBUTION-INDEPENDENT ceiling guarantee', () => {
  it('every pCorrect <= effectiveProbCap = ceiling, on ANY question difficulty', () => {
    // The ONLY distribution-independent bound: since P ≤ cap for every question,
    // the aggregate over ANY mix ≤ cap = ceiling.
    for (const acc of [0.999, 0.99, 0.95, 0.9, 0.8, 0.5, 0.2, 0.05]) {
      const godlike = inputs({ currentRp: 100000, personalOffset: 100, governorAdjustment: 100, categoryAffinities: { football: 100 } });
      const d = decideMcq(params, godlike, statsFromAccuracy(acc), 'football', { ...keys, questionId: `c1-${acc}` });
      expect(d.pCorrect).toBeLessThanOrEqual(effectiveProbCap(params) + 1e-9);
    }
    expect(effectiveProbCap(params)).toBeCloseTo(HARD_CEILING_ACCURACY, 6);
  });

  it('worst reachable aggregate on an ALL-EASY draft = cap <= ceiling AND <= top cohort', () => {
    // The adversarial case Sol flagged: a maxed bot on an all-easy draft. With the
    // cap = ceiling, the aggregate approaches the cap (86.31%) but never exceeds
    // it, and stays below the real top cohort (90.31%).
    const godlike = inputs({ currentRp: 100000, personalOffset: 100, governorAdjustment: 100 });
    let correct = 0;
    const n = 8000;
    for (let i = 0; i < n; i += 1) {
      const d = decideMcq(params, godlike, statsFromAccuracy(0.97), null, { ...keys, questionId: `easy-${i}` });
      correct += d.isCorrect ? 1 : 0;
    }
    const aggregate = correct / n;
    expect(aggregate).toBeLessThanOrEqual(effectiveProbCap(params) + 0.01); // sampling slack
    expect(effectiveProbCap(params)).toBeLessThanOrEqual(HARD_CEILING_ACCURACY + 1e-9);
    expect(effectiveProbCap(params)).toBeLessThan(S1_TOP_COHORT_ACCURACY_HOLDOUT);
  });

  it('solveThetaCeilingBound (the EXPECTED-aggregate nicety) is monotone + has a fallback', () => {
    expect(expectedAggregateAccuracy(1, REAL_BETAS, effectiveProbCap(params)))
      .toBeLessThan(expectedAggregateAccuracy(2, REAL_BETAS, effectiveProbCap(params)));
    const fallback = solveThetaCeilingBound([], params.ceiling.ceilingAccuracy, effectiveProbCap(params));
    expect(fallback).toBeGreaterThan(0);
    expect(fallback).toBeLessThanOrEqual(HARD_SKILL_CAP);
    // The θ bound only tightens the EXPECTED aggregate over the real mix; keep it valid.
    const cap = effectiveSkillCap(params, THETA_CEILING);
    expect(expectedAggregateAccuracy(cap, REAL_BETAS, effectiveProbCap(params)))
      .toBeLessThanOrEqual(params.ceiling.ceilingAccuracy + 1e-6);
  });
});

describe('CRITICAL-2 — immutable clamps applied last + no inversion', () => {
  it('rejects params that loosen the HARD-bounded clamps or use a bad slope', () => {
    const bad2 = JSON.parse(readFileSync(PARAMS_PATH, 'utf8'));
    bad2.clamps.skillCap = 99; // > HARD_SKILL_CAP
    expect(() => parseBotModelParams(bad2)).toThrow();

    const bad3 = JSON.parse(readFileSync(PARAMS_PATH, 'utf8'));
    bad3.clamps.minAnswerTimeMs = 0; // < HARD_MIN_ANSWER_TIME_MS
    expect(() => parseBotModelParams(bad3)).toThrow();

    const bad4 = JSON.parse(readFileSync(PARAMS_PATH, 'utf8'));
    bad4.ceiling.ceilingAccuracy = 0.3; // < MIN_CEILING_ACCURACY (inversion guard)
    expect(() => parseBotModelParams(bad4)).toThrow();

    const bad5 = JSON.parse(readFileSync(PARAMS_PATH, 'utf8'));
    bad5.difficultyLink.slope = 0.5; // non-negative slope inverts difficulty
    expect(() => parseBotModelParams(bad5)).toThrow();
  });

  it('finalProbCap is advisory: the runtime always tightens to HARD_PROB_CAP', () => {
    // The frozen artifact carries 0.93; the runtime min tightens it to the ceiling.
    expect(effectiveProbCap(params)).toBe(HARD_PROB_CAP);
    const loose = { ...params, clamps: { finalProbCap: 1, skillCap: 100, minAnswerTimeMs: 0 } } as BotModelParams;
    expect(effectiveProbCap(loose)).toBe(HARD_PROB_CAP);
    expect(effectiveSkillCap(loose, HARD_SKILL_CAP)).toBe(HARD_SKILL_CAP);
    const d = decideMcq(loose, inputs({ thetaCeilingBound: HARD_SKILL_CAP }), statsFromAccuracy(0.99), null, keys);
    expect(d.pCorrect).toBeLessThanOrEqual(HARD_PROB_CAP + 1e-9);
  });

  it('the skill cap is applied AFTER tilt/form/noise (nothing escapes it)', () => {
    const cap = 1.0;
    expect(effectiveSkillTheta(1.0, 0.6, 0.25, 5.0, cap)).toBe(cap);
    expect(effectiveSkillTheta(-1.0, -0.6, -0.25, -5.0, cap)).toBe(-cap);
  });

  it('a stricter (small) ceiling can NEVER invert the skill cap upward', () => {
    // A large-negative thetaCeilingBound (what a tiny ceiling would produce) must
    // floor the effective cap at 0, forcing theta to 0 (chance level), never +4.
    expect(effectiveSkillCap(params, -4)).toBe(0);
    expect(effectiveSkillCap(params, -100)).toBe(0);
    // With a 0 cap, theta is pinned to 0 regardless of the additive terms.
    expect(effectiveSkillTheta(3, 0.6, 0.25, 2, 0)).toBe(0);
    expect(effectiveSkillTheta(3, 0.6, 0.25, 2, -5)).toBe(0); // negative cap → floored to 0
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

  it('clue reveal-index floor keeps a solved SCORE at/under the ceiling (multi-clue)', () => {
    const minIdx = minClueIndexForCeiling(params);
    expect(calculateCluesScore(true, minIdx)).toBeLessThanOrEqual(ceilScore + 1e-9);
    const clue = decideClue(params, inputs(), { '0': 10, '1': 5 }, 5, keys);
    expect(clue.solved).toBe(true);
    expect(clue.index).toBeGreaterThanOrEqual(minIdx);
    expect(calculateCluesScore(clue.solved, clue.index)).toBeLessThanOrEqual(ceilScore + 1e-9);
  });

  it('COARSE 1-clue question: bot sometimes does NOT solve so E[score] <= ceiling (no forced 100)', () => {
    // A single-clue question can only score 0 or 100. To respect the ceiling the
    // bot must fail some of the time; expected score ≈ ceiling*100, not 100.
    let solvedCount = 0;
    const n = 4000;
    for (let i = 0; i < n; i += 1) {
      const clue = decideClue(params, inputs(), undefined, 1, { ...keys, questionId: `clue1-${i}` });
      // Only index 0 exists; score is 0 (miss) or 100 (solve).
      expect(clue.index).toBe(0);
      if (clue.solved) solvedCount += 1;
    }
    const expectedScore = (solvedCount / n) * 100;
    expect(expectedScore).toBeLessThanOrEqual(ceilScore + 1.5); // sampling slack
    expect(solvedCount).toBeGreaterThan(0); // and not deterministically zero
  });

  it('COARSE 1-group countdown: found is 0 or 1 with P(found) <= ceiling (no forced 100)', () => {
    let foundCount = 0;
    const n = 4000;
    for (let i = 0; i < n; i += 1) {
      const f = decideCountdownFoundCount(params, inputs(), undefined, 1, { ...keys, questionId: `cd1-${i}` });
      expect(f === 0 || f === 1).toBe(true);
      if (f === 1) foundCount += 1;
    }
    const expectedScore = (foundCount / n) * 100; // score(1,1)=100, score(0,1)=0
    expect(expectedScore).toBeLessThanOrEqual(ceilScore + 1.5);
    expect(foundCount).toBeGreaterThan(0); // not deterministically zeroed (the CodeRabbit bug)
  });

  it('1-item put-in-order allows full credit (score 20 <= ceiling, never zeroed)', () => {
    expect(maxPutInOrderMatchedForCeiling(params, 1)).toBe(1);
    const c = decidePutInOrderCorrectCount(params, inputs(), { '1': 10 }, 1, keys);
    expect(c).toBe(1);
    expect(calculatePutInOrderScore(c, 1)).toBe(20);
  });

  it('per-format decisions are deterministic', () => {
    expect(decidePutInOrderCorrectCount(params, inputs(), { '2': 4, '4': 12 }, 6, keys))
      .toBe(decidePutInOrderCorrectCount(params, inputs(), { '2': 4, '4': 12 }, 6, keys));
    expect(decideClue(params, inputs(), undefined, 1, keys))
      .toEqual(decideClue(params, inputs(), undefined, 1, keys));
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
