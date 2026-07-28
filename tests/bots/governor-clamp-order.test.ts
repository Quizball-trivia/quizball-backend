/**
 * The governor must NEVER be able to raise a bot above the Layer-1 hard clamps
 * (PR9 x PR8 interaction, plan §1.5).
 *
 * The governor contributes ONE addend inside baseSkillTheta(); the clamps run
 * strictly AFTER it:
 *   baseSkillTheta = f(RP) + personalOffset + governorAdjustment   <- governor here
 *   effectiveSkillTheta = clamp(base + tilt + form + noise, +/- cap)  <- cap here
 *   pCorrect = min(sigmoid(theta - beta), effectiveProbCap)          <- cap here
 *
 * These tests pin that ORDER by construction: they push the governor to its
 * maximum positive bound and assert the final per-question probability is still
 * capped, on easy questions and with every other term also maxed out.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBotModelParams, type BotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import {
  baseSkillTheta,
  decideMcq,
  effectiveProbCap,
  effectiveSkillCap,
  effectiveSkillTheta,
  type PersistentBotSkillInputs,
} from '../../src/realtime/persistent-bot-gameplay.js';
import { HARD_PROB_CAP, HARD_SKILL_CAP } from '../../src/modules/bots/calibration/hard-clamps.js';
import { MAX_GOVERNOR_ADJUSTMENT } from '../../src/modules/bots/governor/governor-state-machine.js';

const params: BotModelParams = parseBotModelParams(
  JSON.parse(readFileSync(resolve(__dirname, '../realtime/fixtures/params.json'), 'utf8')),
);

function inputs(overrides: Partial<PersistentBotSkillInputs> = {}): PersistentBotSkillInputs {
  return {
    currentRp: 2000,
    personalOffset: 0,
    governorAdjustment: 0,
    categoryAffinities: {},
    dailyFormSeed: '2026-07-28',
    thetaCeilingBound: HARD_SKILL_CAP,
    ...overrides,
  };
}

describe('governor offset enters BEFORE the clamps', () => {
  it('is a plain addend of baseSkillTheta', () => {
    const withoutGovernor = baseSkillTheta(params, inputs());
    const withGovernor = baseSkillTheta(params, inputs({ governorAdjustment: MAX_GOVERNOR_ADJUSTMENT }));
    expect(withGovernor - withoutGovernor).toBeCloseTo(MAX_GOVERNOR_ADJUSTMENT, 10);
  });

  it('a maxed-out positive offset is still clamped by the effective skill cap', () => {
    const cap = effectiveSkillCap(params, HARD_SKILL_CAP);
    // Base already at the cap, then the governor pushes further: still capped.
    const theta = effectiveSkillTheta(cap + MAX_GOVERNOR_ADJUSTMENT, 0, 0, 0, cap);
    expect(theta).toBeLessThanOrEqual(cap);
    expect(theta).toBeLessThanOrEqual(HARD_SKILL_CAP);
  });
});

describe('per-question probability stays under the hard cap with the governor maxed', () => {
  const probCap = effectiveProbCap(params);

  it('effectiveProbCap never exceeds HARD_PROB_CAP', () => {
    expect(probCap).toBeLessThanOrEqual(HARD_PROB_CAP);
  });

  it('holds across the whole difficulty range for a max-boosted, max-skilled bot', () => {
    // Worst case: top-RP bot, max personal offset, max governor boost, and the
    // loosest possible ceiling bound.
    const worstCase = inputs({
      currentRp: 5000,
      personalOffset: HARD_SKILL_CAP,
      governorAdjustment: MAX_GOVERNOR_ADJUSTMENT,
      thetaCeilingBound: HARD_SKILL_CAP,
      // A strongly favourable category on top of everything else.
      categoryAffinities: { football: 10 },
    });
    for (let q = 0; q < 300; q += 1) {
      const decision = decideMcq(
        params,
        worstCase,
        // Trivially easy question (95% human accuracy) — the mix that would
        // otherwise let an aggregate ceiling be beaten.
        { smoothedAccuracy: 0.95, medianTimeMs: 4000, logTimeSigma: 0.5 },
        'football',
        { botId: 'bot-1', matchId: `match-${q}`, questionId: `q-${q}` },
      );
      expect(decision.pCorrect).toBeLessThanOrEqual(probCap);
      expect(decision.pCorrect).toBeLessThanOrEqual(HARD_PROB_CAP);
    }
  });

  it('a max-boosted bot is never more accurate than an already-capped one', () => {
    // Both bots sit at/above the cap, so the governor buys the first one nothing.
    const capped = inputs({ currentRp: 5000, personalOffset: HARD_SKILL_CAP, thetaCeilingBound: HARD_SKILL_CAP });
    const boosted = { ...capped, governorAdjustment: MAX_GOVERNOR_ADJUSTMENT };
    const keys = { botId: 'bot-1', matchId: 'match-1', questionId: 'q-1' };
    const stats = { smoothedAccuracy: 0.9, medianTimeMs: 4000, logTimeSigma: 0.5 };
    const a = decideMcq(params, capped, stats, null, keys);
    const b = decideMcq(params, boosted, stats, null, keys);
    expect(b.pCorrect).toBeCloseTo(a.pCorrect, 10);
  });

  it('the negative bound genuinely LOWERS accuracy (the governor can nerf)', () => {
    // At a mid skill level the offset is not clamp-bound, so it must bite.
    const neutral = inputs({ currentRp: 1500, thetaCeilingBound: HARD_SKILL_CAP });
    const nerfed = { ...neutral, governorAdjustment: -MAX_GOVERNOR_ADJUSTMENT };
    const keys = { botId: 'bot-1', matchId: 'match-1', questionId: 'q-1' };
    const stats = { smoothedAccuracy: 0.5, medianTimeMs: 4000, logTimeSigma: 0.5 };
    expect(decideMcq(params, nerfed, stats, null, keys).pCorrect)
      .toBeLessThan(decideMcq(params, neutral, stats, null, keys).pCorrect);
  });
});
