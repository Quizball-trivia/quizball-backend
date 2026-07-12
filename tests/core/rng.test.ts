import { describe, expect, it } from 'vitest';
import { getRandom, withSeed, seedFrom, isSeeded, seededShuffle, shuffle } from '../../src/core/rng.js';

describe('rng seam', () => {
  it('returns a float in [0, 1) unseeded (prod path = Math.random behaviour)', () => {
    for (let i = 0; i < 100; i++) {
      const r = getRandom();
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    }
  });

  it('is NOT seeded outside a withSeed scope', () => {
    expect(isSeeded()).toBe(false);
  });

  it('is seeded inside a withSeed scope', () => {
    withSeed('match-1', () => {
      expect(isSeeded()).toBe(true);
    });
    expect(isSeeded()).toBe(false);
  });

  it('produces a deterministic, reproducible stream for the same seed', () => {
    const run = () => withSeed('match-abc', () => [getRandom(), getRandom(), getRandom()]);
    const a = run();
    const b = run();
    expect(a).toEqual(b);
  });

  it('produces different streams for different seeds', () => {
    const a = withSeed('seed-A', () => [getRandom(), getRandom(), getRandom()]);
    const b = withSeed('seed-B', () => [getRandom(), getRandom(), getRandom()]);
    expect(a).not.toEqual(b);
  });

  it('isolates concurrent/nested seeded scopes (no global cross-contamination)', async () => {
    // Interleave two seeded scopes via async boundaries; each must keep its own stream.
    const seqA: number[] = [];
    const seqB: number[] = [];
    await Promise.all([
      withSeed('A', async () => {
        seqA.push(getRandom());
        await Promise.resolve();
        seqA.push(getRandom());
      }),
      withSeed('B', async () => {
        seqB.push(getRandom());
        await Promise.resolve();
        seqB.push(getRandom());
      }),
    ]);
    // Each scope reproduces the same stream it would produce in isolation.
    const soloA = withSeed('A', () => [getRandom(), getRandom()]);
    const soloB = withSeed('B', () => [getRandom(), getRandom()]);
    expect(seqA).toEqual(soloA);
    expect(seqB).toEqual(soloB);
  });

  it('seedFrom is stable for the same string and differs across strings', () => {
    expect(seedFrom('match-1')).toBe(seedFrom('match-1'));
    expect(seedFrom('match-1')).not.toBe(seedFrom('match-2'));
    expect(seedFrom(42)).toBe(42);
  });
});

describe('seededShuffle (MCQ option ordering)', () => {
  const OPTS = ['a', 'b', 'c', 'd'];

  it('is a permutation — keeps every element, drops none, adds none', () => {
    const out = seededShuffle(OPTS, 'match-1:0');
    expect([...out].sort()).toEqual([...OPTS].sort());
    expect(out).toHaveLength(OPTS.length);
  });

  it('does not mutate the input array', () => {
    const input = [...OPTS];
    seededShuffle(input, 'match-1:0');
    expect(input).toEqual(OPTS);
  });

  it('is deterministic for the same seed (both players / cache rebuilds match)', () => {
    expect(seededShuffle(OPTS, 'match-1:3')).toEqual(seededShuffle(OPTS, 'match-1:3'));
  });

  it('differs across matches (same question index, different match)', () => {
    // Across many questions the two matches must not be identical for all of
    // them (a single seed could coincidentally no-op; the set must differ).
    const anyDifferent = Array.from({ length: 10 }, (_, q) =>
      seededShuffle(OPTS, `match-A:${q}`).join() !== seededShuffle(OPTS, `match-B:${q}`).join(),
    ).some(Boolean);
    expect(anyDifferent).toBe(true);
  });

  it('correct option can be located after shuffle via a stable key', () => {
    const tagged = [
      { text: 'a', is_correct: false },
      { text: 'b', is_correct: true },
      { text: 'c', is_correct: false },
      { text: 'd', is_correct: false },
    ];
    const shuffled = seededShuffle(tagged, 'match-1:5');
    const idx = shuffled.findIndex((o) => o.is_correct);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(shuffled[idx].text).toBe('b');
  });
});

describe('shuffle', () => {
  it('uses the provided random source and does not mutate input', () => {
    const input = ['a', 'b', 'c', 'd'];
    const randomValues = [0, 0, 0];
    const random = () => randomValues.shift() ?? 0;

    expect(shuffle(input, random)).toEqual(['b', 'c', 'd', 'a']);
    expect(input).toEqual(['a', 'b', 'c', 'd']);
  });
});
