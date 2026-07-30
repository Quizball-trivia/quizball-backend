/**
 * PR10 config resolution + governor threading.
 *
 * Two properties under test:
 *   1. NULL override => the frozen code constant. This is what keeps the
 *      constants authoritative for anything the operator never touched.
 *   2. stepGovernor honours a threaded config while remaining PURE — same
 *      state+input+config always yields the same decision, and the clamp-order
 *      guarantee survives arbitrary (bounded) config.
 */
import { describe, it, expect } from 'vitest';
import '../setup.js';
import { resolveTuning, DEFAULT_RESOLVED_TUNING } from '../../src/modules/bots/tuning/tuning-config.service.js';
import type { BotTuningOverrides } from '../../src/modules/bots/tuning/tuning.repo.js';
import {
  stepGovernor,
  targetWinrate,
  topProtectionZone,
  FROZEN_GOVERNOR_CONFIG,
  MAX_GOVERNOR_ADJUSTMENT,
  GOVERNOR_STEP,
  TOP_PROTECTION_MARGIN_RP,
  MID_LADDER_TARGET_WINRATE,
  MIN_SAMPLES_FOR_WINRATE,
  type GovernorState,
} from '../../src/modules/bots/governor/governor-state-machine.js';
import { S1_CEILING_MARGIN } from '../../src/modules/bots/calibration/hard-clamps.js';

const ALL_NULL: BotTuningOverrides = {
  version: 7,
  ceilingMargin: null,
  topBandTargetWinrate: null,
  midLadderTargetWinrate: null,
  governorStep: null,
  topProtectionStep: null,
  topProtectionMarginRp: null,
  topProtectionCriticalRp: null,
  activityScale: null,
  maxDailyCap: null,
  updatedAt: null,
  updatedBy: null,
};

describe('PR10 resolveTuning: null overrides fall back to code constants', () => {
  it('resolves an all-null row to exactly the frozen defaults', () => {
    const resolved = resolveTuning(ALL_NULL);
    expect(resolved.governor).toEqual(FROZEN_GOVERNOR_CONFIG);
    expect(resolved.ceilingMargin).toBe(S1_CEILING_MARGIN);
    expect(resolved.activityScale).toBe(1);
  });

  it('carries the overrides version through for pin provenance', () => {
    expect(resolveTuning(ALL_NULL).version).toBe(7);
  });

  it('a set override wins over the code constant', () => {
    const resolved = resolveTuning({ ...ALL_NULL, governorStep: 0.2, midLadderTargetWinrate: 0.45 });
    expect(resolved.governor.governorStep).toBe(0.2);
    expect(resolved.governor.midLadderTargetWinrate).toBe(0.45);
    // Untouched knobs still fall back.
    expect(resolved.governor.topProtectionMarginRp).toBe(TOP_PROTECTION_MARGIN_RP);
  });

  it('a non-finite stored value falls back rather than poisoning the config', () => {
    const resolved = resolveTuning({ ...ALL_NULL, governorStep: Number.NaN });
    expect(resolved.governor.governorStep).toBe(GOVERNOR_STEP);
  });

  it('the frozen default bundle matches the state machine constants', () => {
    expect(DEFAULT_RESOLVED_TUNING.governor).toEqual(FROZEN_GOVERNOR_CONFIG);
  });
});

describe('PR10 governor threading: config changes behaviour, purity preserved', () => {
  const baseState: GovernorState = {
    adjustment: 0,
    winrateEma: 0.8,
    winrateSamples: MIN_SAMPLES_FOR_WINRATE + 50,
    updatedAt: null,
    samplesAtAdjustment: 0,
  };
  const baseInput = {
    botRp: 1000,
    humanTop10Rp: 5000, // far away => top-protection clear
    won: true,
    now: new Date('2026-07-29T12:00:00Z'),
    enabled: true,
  };

  it('omitting config reproduces the pre-PR10 frozen behaviour', () => {
    const withoutConfig = stepGovernor(baseState, baseInput);
    const withFrozen = stepGovernor(baseState, { ...baseInput, config: FROZEN_GOVERNOR_CONFIG });
    expect(withoutConfig).toEqual(withFrozen);
    // Winning far too much => step DOWN by exactly one frozen step.
    expect(withoutConfig.next.adjustment).toBeCloseTo(-GOVERNOR_STEP, 6);
  });

  it('a larger threaded step moves the offset further in one settlement', () => {
    const decision = stepGovernor(baseState, {
      ...baseInput,
      config: { ...FROZEN_GOVERNOR_CONFIG, governorStep: 0.25 },
    });
    expect(decision.next.adjustment).toBeCloseTo(-0.25, 6);
  });

  it('is PURE: repeated identical calls yield identical decisions', () => {
    const config = { ...FROZEN_GOVERNOR_CONFIG, governorStep: 0.17 };
    const a = stepGovernor(baseState, { ...baseInput, config });
    const b = stepGovernor(baseState, { ...baseInput, config });
    expect(a).toEqual(b);
  });

  it('CLAMP ORDER survives arbitrary bounded config: |adjustment| <= MAX', () => {
    // The bound is deliberately NOT tunable. Drive the loop hard with the most
    // aggressive legal config and assert it still cannot escape the bound.
    const aggressive = {
      ...FROZEN_GOVERNOR_CONFIG,
      governorStep: 0.25,
      topProtectionStep: 0.5,
    };
    let state: GovernorState = { ...baseState, adjustment: 0 };
    for (let i = 0; i < 40; i++) {
      state = stepGovernor(state, {
        ...baseInput,
        won: false, // losing => tries to BOOST every step
        now: new Date(Date.parse('2026-07-29T12:00:00Z') + i * 7_200_000),
        config: aggressive,
      }).next;
      expect(Math.abs(state.adjustment)).toBeLessThanOrEqual(MAX_GOVERNOR_ADJUSTMENT + 1e-9);
    }
  });

  it('top-protection still DOMINATES with a tuned config (never boosts near the top)', () => {
    // Bot deep inside the protected ring while losing badly: the win-rate arm
    // would boost, top-protection must veto. This is the be#175 failure mode.
    const decision = stepGovernor(
      { ...baseState, adjustment: 0.3, winrateEma: 0.05 },
      {
        ...baseInput,
        botRp: 4990,
        humanTop10Rp: 5000,
        won: false,
        config: { ...FROZEN_GOVERNOR_CONFIG, governorStep: 0.25 },
      },
    );
    expect(decision.next.adjustment).toBeLessThan(0.3);
    expect(decision.trigger).toContain('top_protection');
  });

  it('a widened protection ring engages earlier than the frozen one', () => {
    const botRp = 5000 - TOP_PROTECTION_MARGIN_RP - 50; // outside the frozen ring
    expect(topProtectionZone(botRp, 5000)).toBe('clear');
    expect(
      topProtectionZone(botRp, 5000, {
        ...FROZEN_GOVERNOR_CONFIG,
        topProtectionMarginRp: TOP_PROTECTION_MARGIN_RP + 200,
      }),
    ).toBe('warn');
  });

  it('targetWinrate honours a threaded mid-ladder target', () => {
    expect(targetWinrate(100, 5000)).toBe(MID_LADDER_TARGET_WINRATE);
    expect(
      targetWinrate(100, 5000, { ...FROZEN_GOVERNOR_CONFIG, midLadderTargetWinrate: 0.42 }),
    ).toBe(0.42);
  });
});
