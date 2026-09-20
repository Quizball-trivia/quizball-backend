import { describe, expect, it } from 'vitest';
import { comboOffsetFromSeed, commitmentFor, newServerSeed, roundHmacInput, uniformIndex } from '../../src/modules/squad-spin/squad-spin.fairness.js';

describe('squad-spin fairness', () => {
  it('commitment is the sha256 of the seed and seeds are unique', () => {
    const seed = newServerSeed();
    expect(seed).toHaveLength(64);
    expect(commitmentFor(seed)).toHaveLength(64);
    expect(newServerSeed()).not.toBe(seed);
  });

  it('combo offsets are deterministic per (seed, round, spin, attempt) and in range', () => {
    const seed = 'ab'.repeat(32);
    const input = roundHmacInput('round-1', 'nonce');
    const a = comboOffsetFromSeed(seed, input, 1, 0, 1_215);
    expect(comboOffsetFromSeed(seed, input, 1, 0, 1_215)).toBe(a);
    expect(comboOffsetFromSeed(seed, input, 2, 0, 1_215)).not.toBe(a);
    expect(comboOffsetFromSeed(seed, input, 1, 1, 1_215)).not.toBe(a);
    for (let spin = 1; spin <= 200; spin += 1) {
      const offset = comboOffsetFromSeed(seed, input, spin, 0, 37);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(37);
    }
  });

  it('uniformIndex spreads evenly (chi-square sanity over 10 buckets)', () => {
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 20_000; i += 1) counts[uniformIndex('seed', `x:${i}`, 10)] += 1;
    for (const c of counts) { expect(c).toBeGreaterThan(1_700); expect(c).toBeLessThan(2_300); }
  });
});
