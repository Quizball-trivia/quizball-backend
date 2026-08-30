import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBotModelParams, type BotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import { FCURVE_PERCENTILES } from '../../src/modules/bots/calibration/constants.js';
import {
  CLUE_SOLVE_MIN_SAMPLES,
  decideClue,
  decideCountdownFoundCount,
  decidePutInOrderCorrectCount,
  effectiveProbCap,
  maxCountdownFoundForCeiling,
  sampleHistogram,
  sampleHistogramAtSkill,
  skillPercentile,
  solveThetaCeilingBound,
  type PersistentBotSkillInputs,
} from '../../src/realtime/persistent-bot-gameplay.js';
import { logit } from '../../src/modules/bots/calibration/math.js';
import { calculateCluesScore } from '../../src/realtime/scoring.js';

const params: BotModelParams = parseBotModelParams(
  JSON.parse(readFileSync(resolve(__dirname, 'fixtures/params.json'), 'utf8')),
);
const REAL_BETAS: number[] = [];
for (let a = 0.15; a <= 0.95; a += 0.01) {
  REAL_BETAS.push(params.difficultyLink.intercept + params.difficultyLink.slope * logit(a));
}
const THETA_CEILING = solveThetaCeilingBound(REAL_BETAS, params.ceiling.ceilingAccuracy, effectiveProbCap(params));

function inputs(overrides: Partial<PersistentBotSkillInputs> = {}): PersistentBotSkillInputs {
  return {
    currentRp: 1000,
    personalOffset: 0,
    governorAdjustment: 0,
    categoryAffinities: {},
    dailyFormSeed: '2026-08-30',
    thetaCeilingBound: THETA_CEILING,
    ...overrides,
  };
}

const keys = { botId: 'bot-1', matchId: 'match-1', questionId: 'q-1' };

const rpAtPercentile = (p: number): number => {
  const index = FCURVE_PERCENTILES.indexOf(p as (typeof FCURVE_PERCENTILES)[number]);
  return params.fCurve[index].rp;
};

describe('skillPercentile', () => {
  it('recovers the knot percentiles at the knot RPs', () => {
    for (let i = 0; i < FCURVE_PERCENTILES.length; i += 1) {
      const s = skillPercentile(params, inputs({ currentRp: params.fCurve[i].rp }));
      expect(s).toBeGreaterThanOrEqual(FCURVE_PERCENTILES[0]);
      expect(s).toBeLessThanOrEqual(FCURVE_PERCENTILES[FCURVE_PERCENTILES.length - 1]);
    }
    const median = skillPercentile(params, inputs({ currentRp: rpAtPercentile(0.5) }));
    expect(median).toBeCloseTo(0.5, 1);
  });

  it('is monotone in RP and clamped to the knot grid', () => {
    let prev = -Infinity;
    for (const rp of [0, 200, 500, 800, 1100, 1500, 2500, 10000]) {
      const s = skillPercentile(params, inputs({ currentRp: rp }));
      expect(s).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(s).toBeGreaterThanOrEqual(0.05);
      expect(s).toBeLessThanOrEqual(0.95);
      prev = s;
    }
  });
});

describe('sampleHistogramAtSkill', () => {
  const hist = { 0: 40, 1: 30, 2: 17, 3: 8, 4: 5 };
  const stream = (seed: number) => {
    let x = seed;
    return () => {
      x = (x * 1103515245 + 12345) % 2 ** 31;
      return x / 2 ** 31;
    };
  };

  it('is identical to sampleHistogram at s=0.5 with an increasing scoreOf', () => {
    for (let seed = 1; seed < 200; seed += 1) {
      const a = sampleHistogram(hist, stream(seed));
      const b = sampleHistogramAtSkill(hist, stream(seed), 0.5, (k) => k);
      expect(b).toBe(a);
    }
  });

  it('mean outcome is monotone in s (clue scoring: index 0 is best)', () => {
    const meanScore = (s: number): number => {
      let sum = 0;
      const n = 4000;
      for (let seed = 1; seed <= n; seed += 1) {
        const index = sampleHistogramAtSkill(hist, stream(seed), s, (k) => calculateCluesScore(true, k))!;
        sum += calculateCluesScore(true, index);
      }
      return sum / n;
    };
    const weak = meanScore(0.1);
    const mid = meanScore(0.5);
    const strong = meanScore(0.9);
    expect(weak).toBeLessThan(mid);
    expect(mid).toBeLessThan(strong);
  });

  it('handles degenerate histograms', () => {
    expect(sampleHistogramAtSkill({}, stream(1), 0.5, (k) => k)).toBeNull();
    expect(sampleHistogramAtSkill({ 3: 10 }, stream(1), 0.9, (k) => k)).toBe(3);
  });

  it('preserves the human distribution shape at every roster skill (TV distance <= 0.25)', () => {
    // The raw (1-s)/s tilt collapsed onto the best/worst bucket at roster
    // extremes — a weak bot answered at the LAST clue 67% of the time. The
    // softened tilt must stay within total-variation 0.25 of the human shares
    // for every skill percentile the fCurve can produce ([0.05, 0.95]).
    const prodPrior = { 0: 11710, 1: 8424, 2: 4677, 3: 2183, 4: 1136 };
    const total = Object.values(prodPrior).reduce((a, b) => a + b, 0);
    for (const s of [0.05, 0.15, 0.3, 0.5, 0.7, 0.85, 0.95]) {
      const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
      const n = 20000;
      for (let seed = 1; seed <= n; seed += 1) {
        const index = sampleHistogramAtSkill(prodPrior, stream(seed), s, (k) => calculateCluesScore(true, k))!;
        counts[index] += 1;
      }
      let tv = 0;
      for (const k of [0, 1, 2, 3, 4]) {
        tv += Math.abs(counts[k] / n - prodPrior[k as 0] / total);
      }
      expect(tv / 2, `TV at s=${s}`).toBeLessThanOrEqual(0.26); // 0.25 + sampling slack
    }
  });
});

describe('decideClue — skill x difficulty solve probability', () => {
  const hist = { 0: 40, 1: 30, 2: 17, 3: 8, 4: 5 };
  const solveRateOver = (
    rp: number,
    clueSolve: { rate: number; samples: number } | null,
    n = 3000,
  ): number => {
    let solves = 0;
    for (let i = 0; i < n; i += 1) {
      const d = decideClue(params, inputs({ currentRp: rp }), hist, 5, { ...keys, questionId: `q-${i}` }, clueSolve);
      if (d.solved) solves += 1;
    }
    return solves / n;
  };

  it('a weak bot rarely solves a hard question; a strong bot solves it more', () => {
    const hard = { rate: 0.1, samples: 40 };
    const weak = solveRateOver(rpAtPercentile(0.05), hard);
    const strong = solveRateOver(rpAtPercentile(0.95), hard);
    expect(weak).toBeLessThan(0.1);
    expect(strong).toBeGreaterThan(weak * 1.5);
  });

  it('question difficulty separates solve rates for the SAME bot', () => {
    const rp = rpAtPercentile(0.5);
    const onHard = solveRateOver(rp, { rate: 0.1, samples: 40 });
    const onEasy = solveRateOver(rp, { rate: 0.9, samples: 40 });
    expect(onEasy).toBeGreaterThan(onHard + 0.15);
  });

  it('E[score] still respects the ceiling with the model probability', () => {
    const ceiling = params.ceiling.ceilingAccuracy * 100;
    const godlike = inputs({ currentRp: 100000, personalOffset: 100, governorAdjustment: 100 });
    let totalScore = 0;
    const n = 6000;
    for (let i = 0; i < n; i += 1) {
      const d = decideClue(params, godlike, hist, 5, { ...keys, questionId: `ceil-${i}` }, { rate: 0.95, samples: 200 });
      totalScore += calculateCluesScore(d.solved, d.index);
    }
    expect(totalScore / n).toBeLessThanOrEqual(ceiling + 2); // sampling slack
  });

  it('thin or malformed solve stats do not engage the difficulty link (same NEW-code path as no stats)', () => {
    const legacy = (i: number) => decideClue(params, inputs(), hist, 5, { ...keys, questionId: `legacy-${i}` });
    const cases: Array<{ rate: number; samples: number } | null> = [
      null,
      { rate: 0.1, samples: CLUE_SOLVE_MIN_SAMPLES - 1 },
      { rate: Number.NaN, samples: 50 },
      { rate: 1.7, samples: 50 },
      { rate: -0.2, samples: 50 },
    ];
    for (const clueSolve of cases) {
      for (let i = 0; i < 50; i += 1) {
        const a = legacy(i);
        const b = decideClue(params, inputs(), hist, 5, { ...keys, questionId: `legacy-${i}` }, clueSolve);
        expect(b).toEqual(a);
      }
    }
  });

  it('is deterministic for identical keys', () => {
    const clueSolve = { rate: 0.3, samples: 30 };
    const a = decideClue(params, inputs(), hist, 5, keys, clueSolve);
    const b = decideClue(params, inputs(), hist, 5, keys, clueSolve);
    expect(b).toEqual(a);
  });
});

describe('countdown / put-in-order skill conditioning', () => {
  const countdownHist = { 0: 10, 1: 15, 2: 25, 3: 25, 4: 15, 5: 10 };
  const pioHist = { 0: 16, 1: 18, 2: 30, 4: 36 };

  it('countdown found-count mean is monotone in skill', () => {
    const mean = (rp: number): number => {
      let sum = 0;
      const n = 2500;
      for (let i = 0; i < n; i += 1) {
        sum += decideCountdownFoundCount(params, inputs({ currentRp: rp }), countdownHist, 8, { ...keys, questionId: `cd-${i}` });
      }
      return sum / n;
    };
    expect(mean(rpAtPercentile(0.05))).toBeLessThan(mean(rpAtPercentile(0.95)));
  });

  it('put-in-order count mean is monotone in skill', () => {
    const mean = (rp: number): number => {
      let sum = 0;
      const n = 2500;
      for (let i = 0; i < n; i += 1) {
        sum += decidePutInOrderCorrectCount(params, inputs({ currentRp: rp }), pioHist, 4, { ...keys, questionId: `pio-${i}` });
      }
      return sum / n;
    };
    expect(mean(rpAtPercentile(0.05))).toBeLessThan(mean(rpAtPercentile(0.95)));
  });

  it('the coarse one-group countdown branch is now skill-sensitive', () => {
    expect(maxCountdownFoundForCeiling(params, 1)).toBe(0);
    const successRate = (rp: number): number => {
      let hits = 0;
      const n = 3000;
      for (let i = 0; i < n; i += 1) {
        const found = decideCountdownFoundCount(params, inputs({ currentRp: rp }), undefined, 1, { ...keys, questionId: `coarse-${i}` });
        if (found > 0) hits += 1;
      }
      return hits / n;
    };
    const weak = successRate(rpAtPercentile(0.05));
    const strong = successRate(rpAtPercentile(0.95));
    expect(weak).toBeLessThan(strong);
    expect(strong).toBeLessThanOrEqual(params.ceiling.ceilingAccuracy + 0.02);
  });
});
