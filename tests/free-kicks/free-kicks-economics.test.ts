import { describe, expect, it } from 'vitest';
import {
  FREE_KICKS_MAX_STAKE,
  FREE_KICKS_MIN_STAKE,
  FREE_KICKS_POT_CAP,
  MAX_OPEN,
  MIN_OPEN,
  STATE_MULT_BP,
  applyMultiplier,
} from '../../src/modules/free-kicks/free-kicks.constants.js';

describe('free-kicks economics', () => {
  it('every state pays below fair odds (EV < 1) at exact multipliers', () => {
    for (let k = MIN_OPEN; k <= MAX_OPEN; k += 1) {
      const goalProbability = (k - 1) / k;
      const multiplier = STATE_MULT_BP[k] / 10_000;
      const fair = k / (k - 1);
      expect(multiplier).toBeLessThan(fair);
      const ev = goalProbability * multiplier;
      expect(ev).toBeLessThan(1);
      // ... but the design intent is a *shrinking* margin: RTP grows with k.
      if (k > MIN_OPEN) {
        const previous = ((k - 2) / (k - 1)) * (STATE_MULT_BP[k - 1] / 10_000);
        expect(ev).toBeGreaterThan(previous);
      }
    }
  });

  it('integer flooring never pushes EV to or above 1 for any reachable pot', () => {
    for (let k = MIN_OPEN; k <= MAX_OPEN; k += 1) {
      const goalProbability = (k - 1) / k;
      for (let pot = FREE_KICKS_MIN_STAKE; pot <= FREE_KICKS_MAX_STAKE * 40; pot += 1) {
        const paid = applyMultiplier(pot, k);
        expect(paid).toBeLessThanOrEqual(Math.floor((pot * STATE_MULT_BP[k]) / 10_000));
        expect(goalProbability * paid).toBeLessThan(pot);
      }
    }
  });

  it('compounded runs stay below break-even for every strategy', () => {
    // Any sequence of states k1..kn has expected multiplier Π p_k·m_k < 1.
    const sequences: number[][] = [
      [2],
      [6],
      [6, 6, 6, 6, 6],
      [2, 3, 4, 5, 6],
      [6, 2, 6, 2],
      Array.from({ length: 20 }, () => 6),
    ];
    for (const sequence of sequences) {
      let expected = 1;
      for (const k of sequence) {
        expected *= ((k - 1) / k) * (STATE_MULT_BP[k] / 10_000);
      }
      expect(expected).toBeLessThan(1);
    }
  });

  it('caps the pot at the hard ceiling', () => {
    expect(applyMultiplier(FREE_KICKS_POT_CAP, MAX_OPEN)).toBe(FREE_KICKS_POT_CAP);
    expect(applyMultiplier(10, MAX_OPEN)).toBe(11); // floor(10 × 1.18)
    expect(applyMultiplier(10, MIN_OPEN)).toBe(18); // floor(10 × 1.86)
  });
});
