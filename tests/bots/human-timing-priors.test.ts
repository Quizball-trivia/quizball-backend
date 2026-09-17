import { describe, expect, it } from 'vitest';
import { humanTimingPrior, HUMAN_TIMING_PRIORS } from '../../src/modules/bots/calibration/human-timing-priors.js';

// Prod ranked human answers, 30 days to 2026-09-17, time_ms 200-9999.
describe('humanTimingPrior', () => {
  it('returns the measured p10 / median / log-sigma per phase x difficulty x correctness', () => {
    expect(humanTimingPrior('normal', 'hard', true)).toEqual({ p10Ms: 1046, medianMs: 2477, logSigma: 0.76 });
    expect(humanTimingPrior('normal', 'hard', false)).toEqual({ p10Ms: 1751, medianMs: 5263, logSigma: 0.64 });
    expect(humanTimingPrior('penalty', 'hard', true)).toEqual({ p10Ms: 1048, medianMs: 2492, logSigma: 0.64 });
    expect(humanTimingPrior('normal', 'easy', true)).toEqual({ p10Ms: 911, medianMs: 1676, logSigma: 0.66 });
    expect(humanTimingPrior('penalty', 'medium', false)).toEqual({ p10Ms: 1069, medianMs: 2516, logSigma: 0.63 });
  });

  it('treats any non-penalty phase as normal and unknown difficulty as medium', () => {
    expect(humanTimingPrior('last_attack', 'medium', true)).toEqual(humanTimingPrior('normal', 'medium', true));
    expect(humanTimingPrior('shot', 'easy', false)).toEqual(humanTimingPrior('normal', 'easy', false));
    expect(humanTimingPrior(undefined, undefined, true)).toEqual(humanTimingPrior('normal', 'medium', true));
    expect(humanTimingPrior('penalty', 'legendary', true)).toEqual(humanTimingPrior('penalty', 'medium', true));
  });

  it('humans are 1.5-2.1x slower when wrong in every cell', () => {
    for (const phase of ['normal', 'penalty'] as const) {
      for (const difficulty of ['easy', 'medium', 'hard'] as const) {
        const ratio = HUMAN_TIMING_PRIORS[phase][difficulty].wrong.medianMs / HUMAN_TIMING_PRIORS[phase][difficulty].correct.medianMs;
        expect(ratio).toBeGreaterThan(1.1);
        expect(ratio).toBeLessThan(2.2);
      }
    }
  });
});
