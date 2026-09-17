import { describe, expect, it } from 'vitest';
import { HUMAN_ACCURACY_PRIORS, humanAccuracyPrior } from '../../src/modules/bots/calibration/human-accuracy-priors.js';

// Prod ranked human answers, normal phase, 7 days to 2026-09-17.
describe('humanAccuracyPrior', () => {
  it('returns the measured human accuracy per difficulty label', () => {
    expect(humanAccuracyPrior('easy')).toBe(0.702);
    expect(humanAccuracyPrior('medium')).toBe(0.537);
    expect(humanAccuracyPrior('hard')).toBe(0.42);
    expect(HUMAN_ACCURACY_PRIORS.easy).toBeGreaterThan(HUMAN_ACCURACY_PRIORS.medium);
    expect(HUMAN_ACCURACY_PRIORS.medium).toBeGreaterThan(HUMAN_ACCURACY_PRIORS.hard);
  });

  it('treats an unknown or missing label as medium', () => {
    expect(humanAccuracyPrior('legendary')).toBe(0.537);
    expect(humanAccuracyPrior(undefined)).toBe(0.537);
    expect(humanAccuracyPrior(null)).toBe(0.537);
  });
});
