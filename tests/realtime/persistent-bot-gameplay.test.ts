import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBotModelParams, type BotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import type { ScopeStat } from '../../src/modules/bots/calibration/math.js';
import {
  aggregateCeiling,
  baseSkillTheta,
  boundedCategoryTilt,
  decideClueRevealIndex,
  decideCountdownFoundCount,
  decideMcq,
  decidePutInOrderCorrectCount,
  questionBetaFromStats,
  resolveQuestionStats,
  sampleHistogram,
  topCohortSpeedFloorMs,
  type PersistentBotSkillInputs,
  type ResolvedQuestionStats,
} from '../../src/realtime/persistent-bot-gameplay.js';

// The frozen calibration artifact is the authoritative fixture (PR4 output).
const PARAMS_PATH = '/Users/user/dev/quizball/calibration-s1final/params.json';
const params: BotModelParams = parseBotModelParams(
  JSON.parse(readFileSync(PARAMS_PATH, 'utf8')),
);

function inputs(overrides: Partial<PersistentBotSkillInputs> = {}): PersistentBotSkillInputs {
  return {
    currentRp: 1000,
    personalOffset: 0,
    governorAdjustment: 0,
    categoryAffinities: {},
    dailyFormSeed: '2026-07-28',
    ...overrides,
  };
}

// Turn a smoothed accuracy into the ResolvedQuestionStats the model consumes.
function statsFromAccuracy(acc: number | null, median = 3000, sigma = 0.6): ResolvedQuestionStats {
  return { smoothedAccuracy: acc, medianTimeMs: median, logTimeSigma: sigma };
}

const keys = { botId: 'bot-1', matchId: 'match-1', questionId: 'q-1' };

describe('persistent bot gameplay model — params fixture', () => {
  it('loads and validates the frozen S1 params', () => {
    expect(params.clamps.finalProbCap).toBe(0.93);
    expect(params.ceiling.ceilingAccuracy).toBeCloseTo(0.8630612, 5);
    expect(aggregateCeiling(params)).toBeCloseTo(0.8630612, 5);
    expect(topCohortSpeedFloorMs(params)).toBe(469); // min speed-floor percentile
  });
});

describe('monotonicity', () => {
  it('pCorrect is non-increasing as question difficulty (beta) rises', () => {
    // Sweep smoothed accuracy DOWN (harder) => beta UP => pCorrect DOWN.
    const accs = [0.95, 0.85, 0.75, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05];
    let prev = Infinity;
    for (const acc of accs) {
      const d = decideMcq(params, inputs(), statsFromAccuracy(acc), null, keys);
      expect(d.pCorrect).toBeLessThanOrEqual(prev + 1e-9);
      prev = d.pCorrect;
    }
  });

  it('holds even with an extreme category tilt (tilt cannot re-order difficulty)', () => {
    const strong = inputs({ categoryAffinities: { football: 999 } }); // clamped internally
    const accs = [0.9, 0.7, 0.5, 0.3, 0.1];
    let prev = Infinity;
    for (const acc of accs) {
      const d = decideMcq(params, strong, statsFromAccuracy(acc), 'football', keys);
      expect(d.pCorrect).toBeLessThanOrEqual(prev + 1e-9);
      prev = d.pCorrect;
    }
  });

  it('betaQ rises as accuracy falls (difficulty link sign)', () => {
    expect(questionBetaFromStats(params, 0.9)).toBeLessThan(questionBetaFromStats(params, 0.3));
  });
});

describe('hard clamps (non-overridable)', () => {
  it('final pCorrect never exceeds finalProbCap regardless of skill / tilt / form', () => {
    const godlike = inputs({
      currentRp: 100000,
      personalOffset: 100,
      governorAdjustment: 100,
      categoryAffinities: { football: 100 },
    });
    // Easiest possible question (accuracy ~1) + max everything.
    for (const acc of [0.999, 0.99, 0.9]) {
      const d = decideMcq(params, godlike, statsFromAccuracy(acc), 'football', keys);
      expect(d.pCorrect).toBeLessThanOrEqual(params.clamps.finalProbCap + 1e-9);
    }
  });

  it('effective skill is bounded by skillCap', () => {
    const capped = baseSkillTheta(params, inputs({ currentRp: 1e9, personalOffset: 50, governorAdjustment: 50 }));
    expect(capped).toBeLessThanOrEqual(params.clamps.skillCap);
    const cappedLow = baseSkillTheta(params, inputs({ currentRp: 0, personalOffset: -50, governorAdjustment: -50 }));
    expect(cappedLow).toBeGreaterThanOrEqual(-params.clamps.skillCap);
  });

  it('sampled answer time never dips below the speed floor', () => {
    const floor = topCohortSpeedFloorMs(params);
    // Question with a tiny median tries to pull times below the floor.
    for (let i = 0; i < 200; i += 1) {
      const d = decideMcq(
        params,
        inputs(),
        statsFromAccuracy(0.5, 10, 0.1),
        null,
        { ...keys, questionId: `q-${i}` },
      );
      expect(d.answerTimeMs).toBeGreaterThanOrEqual(Math.min(floor, params.clamps.minAnswerTimeMs));
      expect(d.answerTimeMs).toBeGreaterThanOrEqual(params.clamps.minAnswerTimeMs);
      expect(d.answerTimeMs).toBeGreaterThanOrEqual(floor);
    }
  });

  it('a realistic top-band bot aggregates under the ceiling over the real mix', () => {
    // §1.5: the ceiling is a telemetry-verified aggregate over the ACTUAL
    // difficulty mix, enforced via skillCap + finalProbCap. The OPERATING point
    // of the strongest real bot is the top of f(RP) (~1.21 theta) plus a bounded
    // hidden-ability offset — NOT the skillCap (4), which is a pathological
    // safety rail, not a reachable in-match theta. A bot at that realistic top
    // must land under the frozen ceiling AND below the real top-cohort accuracy
    // (the δ target: top bots play slightly worse than same-band humans).
    const topRp = params.fCurve[params.fCurve.length - 1].rp;
    const topBand = inputs({ currentRp: topRp, personalOffset: 0.3, governorAdjustment: 0 });
    let correct = 0;
    const n = 6000;
    for (let i = 0; i < n; i += 1) {
      // Beta symmetric around 0 reflects the mean-zero-anchored S1 difficulty
      // spread; invert the difficulty link to the smoothed accuracy the model
      // consumes.
      const betaStream = ((i * 2654435761) >>> 0) / 4294967296;
      const beta = (betaStream * 2 - 1) * 2; // beta in [-2, 2]
      const z = (beta - params.difficultyLink.intercept) / params.difficultyLink.slope;
      const acc = 1 / (1 + Math.exp(-z));
      const d = decideMcq(params, topBand, statsFromAccuracy(acc), null, { ...keys, questionId: `qc-${i}` });
      correct += d.isCorrect ? 1 : 0;
    }
    const aggregate = correct / n;
    expect(aggregate).toBeLessThanOrEqual(params.ceiling.ceilingAccuracy);
    // And strictly below the real top cohort (the downward-δ intent).
    expect(aggregate).toBeLessThan(params.ceiling.topAggregateAccuracyHoldout ?? 1);
  });
});

describe('determinism', () => {
  it('same (botId,matchId,questionId,params) => identical decision', () => {
    const a = decideMcq(params, inputs(), statsFromAccuracy(0.6), 'football', keys);
    const b = decideMcq(params, inputs(), statsFromAccuracy(0.6), 'football', keys);
    expect(a).toEqual(b);
  });

  it('different questionId => independent stream (not identical)', () => {
    const a = decideMcq(params, inputs(), statsFromAccuracy(0.6), null, keys);
    const b = decideMcq(params, inputs(), statsFromAccuracy(0.6), null, { ...keys, questionId: 'q-2' });
    // Not asserting inequality of the boolean (could coincide); assert the time
    // differs, which it must with an independent stream.
    expect(a.answerTimeMs === b.answerTimeMs && a.isCorrect === b.isCorrect).toBe(false);
  });
});

describe('never reads the human answer', () => {
  it('decision is a pure function of params/inputs/stats/keys only', () => {
    // The signature has no human-answer parameter; recomputing at "reveal time"
    // with the same inputs yields the same result.
    const atShow = decideMcq(params, inputs(), statsFromAccuracy(0.55), 'trivia', keys);
    const atReveal = decideMcq(params, inputs(), statsFromAccuracy(0.55), 'trivia', keys);
    expect(atReveal).toEqual(atShow);
  });
});

describe('category tilt bounding', () => {
  it('tilt vanishes at difficulty extremes and peaks near the middle', () => {
    const mid = boundedCategoryTilt(0.6, 0);
    const hard = boundedCategoryTilt(0.6, 4);
    const easy = boundedCategoryTilt(0.6, -4);
    expect(Math.abs(mid)).toBeGreaterThan(Math.abs(hard));
    expect(Math.abs(mid)).toBeGreaterThan(Math.abs(easy));
    expect(Math.abs(hard)).toBeLessThan(0.05);
  });

  it('affinity is clamped to MAX_CATEGORY_TILT_THETA', () => {
    expect(boundedCategoryTilt(999, 0)).toBeCloseTo(boundedCategoryTilt(0.6, 0), 9);
    expect(boundedCategoryTilt(-999, 0)).toBeCloseTo(boundedCategoryTilt(-0.6, 0), 9);
  });
});

describe('per-format models (not Bernoulli)', () => {
  it('countdown uses the found-count distribution and caps the found fraction', () => {
    const dist = { '1': 5, '3': 20, '5': 10 };
    const found = decideCountdownFoundCount(params, inputs(), dist, 6, keys);
    expect(found).toBeGreaterThanOrEqual(0);
    expect(found).toBeLessThanOrEqual(Math.floor(6 * params.clamps.finalProbCap));
  });

  it('put-in-order uses the partial-credit distribution and caps it', () => {
    const dist = { '2': 4, '4': 12, '6': 3 };
    const c = decidePutInOrderCorrectCount(params, inputs(), dist, 6, keys);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(Math.min(6, Math.floor(6 * params.clamps.finalProbCap)));
  });

  it('clue reveal index respects clue bounds', () => {
    const dist = { '0': 2, '1': 8, '2': 5 };
    const idx = decideClueRevealIndex(params, inputs(), dist, 5, keys);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThanOrEqual(4);
  });

  it('per-format decisions are deterministic', () => {
    const dist = { '2': 4, '4': 12 };
    expect(decidePutInOrderCorrectCount(params, inputs(), dist, 6, keys))
      .toBe(decidePutInOrderCorrectCount(params, inputs(), dist, 6, keys));
  });

  it('sampleHistogram is a proper weighted draw', () => {
    const counts = new Map<number, number>();
    let r = 0;
    const dist = { '0': 1, '1': 3 };
    // Feed a rising uniform to cover the whole CDF.
    for (let i = 0; i < 1000; i += 1) {
      const next = () => ((r = (r + 0.001) % 1), r);
      const s = sampleHistogram(dist, next);
      if (s != null) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    expect((counts.get(1) ?? 0)).toBeGreaterThan(counts.get(0) ?? 0);
  });
});

describe('backoff resolves for a brand-new question with no stats', () => {
  const emptyGlobal: ScopeStat = {
    answersCount: 100000,
    correctCount: 50000,
    smoothedAccuracy: 0.5,
    timingSamples: 100000,
    medianTimeMs: 1184,
    logTimeSigma: 0.72,
  };

  it('falls all the way back to global when the question has no row', () => {
    const resolved = resolveQuestionStats(null, null, null, emptyGlobal);
    expect(resolved.smoothedAccuracy).toBe(0.5);
    expect(resolved.medianTimeMs).toBe(1184);
    const d = decideMcq(params, inputs(), resolved, null, keys);
    expect(d.pCorrect).toBeGreaterThan(0);
    expect(d.pCorrect).toBeLessThanOrEqual(params.clamps.finalProbCap);
  });

  it('null smoothed accuracy => beta 0 (median difficulty), still bounded', () => {
    const resolved: ResolvedQuestionStats = { smoothedAccuracy: null, medianTimeMs: null, logTimeSigma: null };
    const d = decideMcq(params, inputs(), resolved, null, keys);
    expect(Number.isFinite(d.pCorrect)).toBe(true);
    expect(d.answerTimeMs).toBeGreaterThanOrEqual(topCohortSpeedFloorMs(params));
  });
});
