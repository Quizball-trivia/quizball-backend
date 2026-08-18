import { describe, expect, it } from 'vitest';
import {
  commitmentFor,
  keeperHmacInput,
  keeperZoneFromSeed,
  newServerSeed,
  verifyShot,
} from '../../src/modules/free-kicks/free-kicks.fairness.js';
import { MAX_OPEN, MIN_OPEN, OPEN_ORDER, openZones } from '../../src/modules/free-kicks/free-kicks.constants.js';

describe('free-kicks fairness', () => {
  it('commit/reveal round-trips and rejects tampering', () => {
    const seed = newServerSeed();
    const commit = commitmentFor(seed);
    const input = keeperHmacInput('round-1', 0, 3, 'nonce');
    const { zone } = keeperZoneFromSeed(seed, input, 3);

    expect(verifyShot({ serverSeed: seed, commitHash: commit, hmacInput: input, openCount: 3, keeperZone: zone })).toBe(true);
    expect(verifyShot({ serverSeed: newServerSeed(), commitHash: commit, hmacInput: input, openCount: 3, keeperZone: zone })).toBe(false);
    const otherZone = OPEN_ORDER.find((candidate) => candidate !== zone)!;
    expect(verifyShot({ serverSeed: seed, commitHash: commit, hmacInput: input, openCount: 3, keeperZone: otherZone })).toBe(false);
  });

  it('is deterministic for identical inputs', () => {
    const seed = newServerSeed();
    const input = keeperHmacInput('round-2', 4, 5, null);
    const first = keeperZoneFromSeed(seed, input, 5);
    const second = keeperZoneFromSeed(seed, input, 5);
    expect(first).toEqual(second);
  });

  it('the player pick is not an input — derivation depends only on seed/round/attack/k/nonce', () => {
    // Structural guarantee: the input string has no pick slot at all.
    const input = keeperHmacInput('round-3', 2, 4, 'abc');
    expect(input).toBe('round-3:2:4:abc:v1');
  });

  it('keeper distribution is uniform over open zones for every k', () => {
    for (let k = MIN_OPEN; k <= MAX_OPEN; k += 1) {
      const counts = new Map<string, number>();
      const trials = 20_000;
      const seed = newServerSeed();
      for (let i = 0; i < trials; i += 1) {
        const { zone } = keeperZoneFromSeed(seed, keeperHmacInput(`round-${i}`, i % 7, k, String(i)), k);
        counts.set(zone, (counts.get(zone) ?? 0) + 1);
      }
      const zones = openZones(k);
      expect([...counts.keys()].sort()).toEqual([...zones].sort());
      const expected = trials / k;
      // 6 standard deviations of a Binomial(trials, 1/k) count — vanishingly
      // unlikely to trip for a uniform sampler at any k.
      const sigma = Math.sqrt(trials * (1 / k) * (1 - 1 / k));
      for (const zone of zones) {
        const observed = counts.get(zone) ?? 0;
        expect(Math.abs(observed - expected)).toBeLessThan(6 * sigma);
      }
    }
  });

  it('never returns a zone outside the open set', () => {
    const seed = newServerSeed();
    for (let i = 0; i < 2_000; i += 1) {
      const k = MIN_OPEN + (i % (MAX_OPEN - MIN_OPEN + 1));
      const { zone, index } = keeperZoneFromSeed(seed, keeperHmacInput('r', i, k, null), k);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(k);
      expect(openZones(k)).toContain(zone);
    }
  });
});
