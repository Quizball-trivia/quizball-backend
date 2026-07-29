/**
 * PR10 SAFETY RAILS — the pure-unit half.
 *
 * These assert the property the whole tuning surface rests on: an operator can
 * make bots WEAKER but never STRONGER than the frozen calibration shipped in
 * PR8. Every rail is checked against the schema (layer 1); the migration's CHECK
 * constraints are layer 2 and are exercised by the integration tests.
 */
import { describe, it, expect } from 'vitest';
import '../setup.js';
import {
  updateBotTuningBodySchema,
  freezeBotBodySchema,
  zeroOffsetsBodySchema,
  rosterOverviewQuerySchema,
  ceilingAccuracyForMargin,
  marginRaisesCeiling,
  MIN_CEILING_MARGIN,
  MAX_TARGET_WINRATE,
  MAX_GOVERNOR_STEP,
  MAX_DAILY_CAP,
} from '../../src/modules/bots/tuning/tuning.schemas.js';
import { HARD_PROB_CAP, S1_CEILING_MARGIN } from '../../src/modules/bots/calibration/hard-clamps.js';

describe('PR10 tuning rails: ceiling margin may only tighten', () => {
  it('REJECTS a margin smaller than the frozen S1 margin (would raise bot ability)', () => {
    // 0.02 < 0.04 => ceiling 0.8831 > HARD_PROB_CAP 0.8631. This is the single
    // most important rejection in the PR: it is the "make bots stronger" path.
    const result = updateBotTuningBodySchema.safeParse({ ceilingMargin: 0.02 });
    expect(result.success).toBe(false);
  });

  it('REJECTS a margin of 0 (ceiling at the raw top-cohort accuracy)', () => {
    expect(updateBotTuningBodySchema.safeParse({ ceilingMargin: 0 }).success).toBe(false);
  });

  it('ACCEPTS the frozen margin exactly (no-op is legal)', () => {
    const result = updateBotTuningBodySchema.safeParse({ ceilingMargin: S1_CEILING_MARGIN });
    expect(result.success).toBe(true);
  });

  it('ACCEPTS a LARGER margin (tightening => weaker bots)', () => {
    const result = updateBotTuningBodySchema.safeParse({ ceilingMargin: 0.10 });
    expect(result.success).toBe(true);
    expect(ceilingAccuracyForMargin(0.10)).toBeLessThan(HARD_PROB_CAP);
  });

  it('marginRaisesCeiling agrees with the hard cap at the boundary', () => {
    expect(marginRaisesCeiling(MIN_CEILING_MARGIN)).toBe(false);
    expect(marginRaisesCeiling(MIN_CEILING_MARGIN - 0.001)).toBe(true);
  });

  it('no ACCEPTED margin ever implies a ceiling above HARD_PROB_CAP', () => {
    // Property sweep across the whole accepted range rather than spot values.
    for (let margin = 0; margin <= 0.45; margin += 0.005) {
      const accepted = updateBotTuningBodySchema.safeParse({ ceilingMargin: margin }).success;
      if (accepted) {
        expect(ceilingAccuracyForMargin(margin)).toBeLessThanOrEqual(HARD_PROB_CAP + 1e-9);
      }
    }
  });
});

describe('PR10 tuning rails: win-rate targets are DIRECTIONAL (no higher than frozen)', () => {
  it('REJECTS a top-band target above 0.55', () => {
    expect(updateBotTuningBodySchema.safeParse({ topBandTargetWinrate: 0.6 }).success).toBe(false);
  });

  it('REJECTS a mid-ladder target above 0.55', () => {
    expect(updateBotTuningBodySchema.safeParse({ midLadderTargetWinrate: 0.56 }).success).toBe(false);
  });

  it('ACCEPTS targets at and below the FROZEN values', () => {
    expect(updateBotTuningBodySchema.safeParse({ midLadderTargetWinrate: 0.5 }).success).toBe(true);
    expect(updateBotTuningBodySchema.safeParse({ topBandTargetWinrate: 0.425 }).success).toBe(true);
    expect(updateBotTuningBodySchema.safeParse({ midLadderTargetWinrate: 0.4 }).success).toBe(true);
  });

  it('REJECTS a target ABOVE frozen even though it is under the 0.55 brief cap', () => {
    // The decisive directional case (Sol P0#1): 0.55 <= the brief's absolute
    // cap, but > the frozen 0.50/0.425, so it would make bots win MORE than
    // the shipped calibration.
    expect(updateBotTuningBodySchema.safeParse({ midLadderTargetWinrate: 0.55 }).success).toBe(false);
    expect(updateBotTuningBodySchema.safeParse({ topBandTargetWinrate: 0.5 }).success).toBe(false);
  });

  it('REJECTS a non-positive target', () => {
    expect(updateBotTuningBodySchema.safeParse({ midLadderTargetWinrate: 0 }).success).toBe(false);
  });
});

describe('PR10 tuning rails: step + ring sizes are DIRECTIONAL', () => {
  it('REJECTS an oversized governor step', () => {
    expect(updateBotTuningBodySchema.safeParse({ governorStep: 0.9 }).success).toBe(false);
  });

  it('ACCEPTS a step at the frozen bound and below (slower boosts)', () => {
    expect(updateBotTuningBodySchema.safeParse({ governorStep: MAX_GOVERNOR_STEP }).success).toBe(true);
    expect(updateBotTuningBodySchema.safeParse({ governorStep: 0.05 }).success).toBe(true);
  });

  it('REJECTS RAISING the symmetric governor step (would accelerate boosts)', () => {
    expect(updateBotTuningBodySchema.safeParse({ governorStep: 0.25 }).success).toBe(false);
  });

  it('REJECTS an oversized top-protection step', () => {
    expect(updateBotTuningBodySchema.safeParse({ topProtectionStep: 0.75 }).success).toBe(false);
  });

  it('REJECTS SHRINKING the top-protection step (slower escape from the top)', () => {
    expect(updateBotTuningBodySchema.safeParse({ topProtectionStep: 0.1 }).success).toBe(false);
  });

  it('ACCEPTS growing the top-protection step', () => {
    expect(updateBotTuningBodySchema.safeParse({ topProtectionStep: 0.4 }).success).toBe(true);
  });

  it('REJECTS NARROWING a protection ring (protection would engage later)', () => {
    expect(updateBotTuningBodySchema.safeParse({ topProtectionMarginRp: 50 }).success).toBe(false);
    expect(updateBotTuningBodySchema.safeParse({ topProtectionCriticalRp: 10 }).success).toBe(false);
  });

  it('ACCEPTS widening the protection rings', () => {
    expect(updateBotTuningBodySchema.safeParse({ topProtectionMarginRp: 400 }).success).toBe(true);
  });
});

describe('PR10 tuning rails: daily cap <= 12', () => {
  it('REJECTS a daily cap above 12', () => {
    expect(updateBotTuningBodySchema.safeParse({ maxDailyCap: 13 }).success).toBe(false);
    expect(updateBotTuningBodySchema.safeParse({ maxDailyCap: 50 }).success).toBe(false);
  });

  it('ACCEPTS a daily cap at the rail', () => {
    expect(updateBotTuningBodySchema.safeParse({ maxDailyCap: MAX_DAILY_CAP }).success).toBe(true);
  });

  it('REJECTS a non-integer or zero cap', () => {
    expect(updateBotTuningBodySchema.safeParse({ maxDailyCap: 8.5 }).success).toBe(false);
    expect(updateBotTuningBodySchema.safeParse({ maxDailyCap: 0 }).success).toBe(false);
  });
});

describe('PR10 tuning rails: structural guards', () => {
  it('REJECTS an unknown key (strict) so a typo cannot silently no-op', () => {
    expect(updateBotTuningBodySchema.safeParse({ celingMargin: 0.1 }).success).toBe(false);
  });

  it('REJECTS a critical ring wider than the warn ring', () => {
    const result = updateBotTuningBodySchema.safeParse({
      topProtectionMarginRp: 100,
      topProtectionCriticalRp: 300,
    });
    expect(result.success).toBe(false);
  });

  it('REJECTS an EMPTY update (would bump the version for nothing)', () => {
    expect(updateBotTuningBodySchema.safeParse({}).success).toBe(false);
    expect(updateBotTuningBodySchema.safeParse({ updatedBy: 'me' }).success).toBe(false);
  });

  it('ACCEPTS explicit null as "reset to the code constant"', () => {
    const result = updateBotTuningBodySchema.safeParse({ ceilingMargin: null, governorStep: null });
    expect(result.success).toBe(true);
  });

  it('zero-offsets requires an explicit confirm:true', () => {
    expect(zeroOffsetsBodySchema.safeParse({}).success).toBe(false);
    expect(zeroOffsetsBodySchema.safeParse({ confirm: false }).success).toBe(false);
    expect(zeroOffsetsBodySchema.safeParse({ confirm: true }).success).toBe(true);
  });

  it('freeze body requires a boolean', () => {
    expect(freezeBotBodySchema.safeParse({ frozen: 'yes' }).success).toBe(false);
    expect(freezeBotBodySchema.safeParse({ frozen: true }).success).toBe(true);
  });

  it('roster query clamps page size and defaults sensibly', () => {
    expect(rosterOverviewQuerySchema.safeParse({ pageSize: 5000 }).success).toBe(false);
    const parsed = rosterOverviewQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.sort).toBe('rp');
  });
});
