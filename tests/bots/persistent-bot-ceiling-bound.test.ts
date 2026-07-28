import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBotModelParams, type BotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import { solveCeilingBound } from '../../src/modules/bots/persistent-bot-context.service.js';
import {
  effectiveProbCap,
  expectedAggregateAccuracy,
} from '../../src/realtime/persistent-bot-gameplay.js';
import { logit } from '../../src/modules/bots/calibration/math.js';
import { HARD_SKILL_CAP, HARD_THETA_CEILING_FALLBACK } from '../../src/modules/bots/calibration/hard-clamps.js';

const params: BotModelParams = parseBotModelParams(
  JSON.parse(readFileSync('/Users/user/dev/quizball/calibration-s1final/params.json', 'utf8')),
);

describe('pin-time ceiling bound (solveCeilingBound)', () => {
  const accs: number[] = [];
  for (let a = 0.15; a <= 0.95; a += 0.01) accs.push(a);
  const betas = accs.map((a) => params.difficultyLink.intercept + params.difficultyLink.slope * logit(a));

  it('the bound keeps expected aggregate over the real mix at/under the ceiling', () => {
    const bound = solveCeilingBound(params, accs);
    const agg = expectedAggregateAccuracy(bound, betas, effectiveProbCap(params));
    expect(agg).toBeLessThanOrEqual(params.ceiling.ceilingAccuracy + 1e-6);
    // And a bot at the bound sits below the real top cohort (§1.5 downward delta).
    expect(agg).toBeLessThan(params.ceiling.topAggregateAccuracyHoldout ?? 1);
  });

  it('returns the conservative frozen fallback for an empty distribution', () => {
    expect(solveCeilingBound(params, [])).toBe(Math.min(HARD_THETA_CEILING_FALLBACK, HARD_SKILL_CAP));
  });
});
