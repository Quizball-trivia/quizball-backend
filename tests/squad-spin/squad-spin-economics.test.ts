import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_MAX_ACCURACY_BP,
  CALIBRATION_MAX_DRIFT_BELOW_PRIOR_BP,
  PRICING_MAX_ACCURACY_BP,
  PRICING_SKILL_GAP_BP,
  RUN_MULT_CAP_BP,
  runPotCap,
  CALIBRATION_MAX_DAILY_DROP_BP,
  CALIBRATION_MIN_ACCURACY_BP,
  LAUNCH_HAIRCUT_BP,
  LAUNCH_HAIRCUT_MIN_SAMPLES,
  MARGIN_BP,
  SQUAD_SPIN_MAX_STAKE,
  SQUAD_SPIN_MIN_STAKE,
  SQUAD_SPIN_POT_CAP,
  SQUAD_SPIN_TIERS,
  TIER_PRIOR_ACCURACY_BP,
  cashoutValue,
  fairPotAfterSpin,
  fairStepBp,
  tierFor,
} from '../../src/modules/squad-spin/squad-spin.constants.js';
import { computeCalibration } from '../../src/modules/squad-spin/squad-spin.calibration.js';

describe('squad-spin economics', () => {
  it('a fair step times its accuracy is break-even before the margin', () => {
    for (const tier of SQUAD_SPIN_TIERS) {
      const accuracy = TIER_PRIOR_ACCURACY_BP[tier] / 10_000;
      const step = fairStepBp(TIER_PRIOR_ACCURACY_BP[tier]) / 10_000;
      expect(accuracy * step).toBeCloseTo(1, 2);
    }
  });

  it('every reachable pot pays below fair odds after the margin, for every tier and stake', () => {
    const calibration = computeCalibration([], null);
    for (const tier of SQUAD_SPIN_TIERS) {
      const p = calibration.accuracy[tier] / 10_000;
      for (let pot = SQUAD_SPIN_MIN_STAKE; pot <= SQUAD_SPIN_MAX_STAKE * 20; pot += 7) {
        const next = fairPotAfterSpin(pot, calibration.steps[tier], SQUAD_SPIN_MAX_STAKE);
        // Continuing from a cash-out-able pot: EV of the next spin's cash-out value < current cash-out value.
        expect(p * cashoutValue(next, calibration.steps.margin)).toBeLessThan(Math.max(cashoutValue(pot, calibration.steps.margin), pot * 0.999));
      }
    }
  });

  it('pot never exceeds the global cap nor the per-run multiple of the stake', () => {
    expect(fairPotAfterSpin(SQUAD_SPIN_POT_CAP, 40_000, SQUAD_SPIN_MAX_STAKE)).toBe(runPotCap(SQUAD_SPIN_MAX_STAKE));
    expect(fairPotAfterSpin(SQUAD_SPIN_POT_CAP - 1, 10_001, SQUAD_SPIN_MAX_STAKE)).toBeLessThanOrEqual(SQUAD_SPIN_POT_CAP);
    expect(fairPotAfterSpin(10_000, 40_000, 10)).toBe(runPotCap(10));
    expect(runPotCap(10)).toBe(Math.floor((10 * RUN_MULT_CAP_BP) / 10_000));
  });

  it('steps are priced for a player better than the measured population', () => {
    const c = computeCalibration([], null);
    for (const tier of SQUAD_SPIN_TIERS) {
      expect(c.steps[tier]).toBe(fairStepBp(Math.min(PRICING_MAX_ACCURACY_BP, c.accuracy[tier] + PRICING_SKILL_GAP_BP)));
      expect((c.accuracy[tier] / 10_000) * (c.steps[tier] / 10_000)).toBeLessThan(1);
    }
  });

  it('a perfect solver still returns less than the stake once the pool is seasoned', () => {
    const seasoned = SQUAD_SPIN_TIERS.map((tier) => ({ tier, correct: 100_000, total: 100_000 }));
    const c = computeCalibration(seasoned, null);
    for (const tier of SQUAD_SPIN_TIERS) {
      const stake = SQUAD_SPIN_MAX_STAKE;
      expect(cashoutValue(fairPotAfterSpin(stake, c.steps[tier], stake), c.steps.margin)).toBeLessThan(stake);
    }
  });

  it('tiers follow reel count and answer count', () => {
    expect(tierFor(3, 5)).toBe('t3e');
    expect(tierFor(3, 2)).toBe('t3m');
    expect(tierFor(4, 1)).toBe('t4');
    expect(tierFor(5, 9)).toBe('t5');
  });

  describe('calibration', () => {
    it('uses the priors and the launch haircut when nothing is observed', () => {
      const c = computeCalibration([], null);
      for (const tier of SQUAD_SPIN_TIERS) expect(c.accuracy[tier]).toBe(TIER_PRIOR_ACCURACY_BP[tier]);
      expect(c.steps.margin).toBe(Math.floor((MARGIN_BP * LAUNCH_HAIRCUT_BP) / 10_000));
    });

    it('moves towards observed accuracy and drops the haircut once every tier is seasoned', () => {
      const obs = SQUAD_SPIN_TIERS.map((tier) => ({ tier, correct: Math.round(LAUNCH_HAIRCUT_MIN_SAMPLES * 0.8), total: LAUNCH_HAIRCUT_MIN_SAMPLES }));
      const c = computeCalibration(obs, null);
      expect(c.steps.margin).toBe(MARGIN_BP);
      expect(c.accuracy.t5).toBeGreaterThan(TIER_PRIOR_ACCURACY_BP.t5);
      expect(c.accuracy.t5).toBeLessThan(8_000);
    });

    it('clamps accuracy into the allowed band and never far below the prior', () => {
      const perfect = SQUAD_SPIN_TIERS.map((tier) => ({ tier, correct: 100_000, total: 100_000 }));
      const hopeless = SQUAD_SPIN_TIERS.map((tier) => ({ tier, correct: 0, total: 100_000 }));
      for (const tier of SQUAD_SPIN_TIERS) {
        expect(computeCalibration(perfect, null).accuracy[tier]).toBe(CALIBRATION_MAX_ACCURACY_BP);
        expect(computeCalibration(hopeless, null).accuracy[tier]).toBe(Math.max(CALIBRATION_MIN_ACCURACY_BP, TIER_PRIOR_ACCURACY_BP[tier] - CALIBRATION_MAX_DRIFT_BELOW_PRIOR_BP));
      }
    });

    it('lets accuracy fall by at most the daily cap versus the previous snapshot, but rise freely', () => {
      const previous = { accuracy_bp: { t3e: 8_000, t3m: 8_000, t4: 8_000, t5: 8_000 } };
      const hopeless = SQUAD_SPIN_TIERS.map((tier) => ({ tier, correct: 0, total: 100_000 }));
      const c = computeCalibration(hopeless, previous);
      for (const tier of SQUAD_SPIN_TIERS) expect(c.accuracy[tier]).toBe(8_000 - CALIBRATION_MAX_DAILY_DROP_BP);
      const great = SQUAD_SPIN_TIERS.map((tier) => ({ tier, correct: 90_000, total: 100_000 }));
      const up = computeCalibration(great, { accuracy_bp: { t3e: 3_000, t3m: 3_000, t4: 3_000, t5: 3_000 } });
      for (const tier of SQUAD_SPIN_TIERS) expect(up.accuracy[tier]).toBeGreaterThan(8_500);
    });
  });
});
