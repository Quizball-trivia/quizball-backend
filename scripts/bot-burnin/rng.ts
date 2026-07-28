/**
 * Seeded, reproducible RNG for the burn-in engine. A mulberry32 generator: a
 * fixed seed yields an identical fixture plan every run (required for the
 * dry-run → --execute equivalence and for resumable idempotency keys).
 */
export function makeRng(seed: number): Rng {
  let s = seed >>> 0 || 0x9e3779b9;
  const next = (): number => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (minInclusive: number, maxInclusive: number) =>
      minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1)),
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)],
    bernoulli: (p: number) => next() < p,
  };
}

export interface Rng {
  next(): number;
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(arr: readonly T[]): T;
  bernoulli(p: number): boolean;
}

/** Derive a stable child seed from a parent seed + a label (per-bot streams). */
export function deriveSeed(parentSeed: number, label: string): number {
  let h = parentSeed >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}
