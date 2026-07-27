/**
 * Deterministic PRNG + seed derivation for the roster generator.
 *
 * Design (per statistical review):
 *   - ONE master seed drives everything. The approved report embeds this seed;
 *     re-running the generator with the same seed reproduces the identical
 *     roster, so the creation script can rebuild exactly what a human approved.
 *   - Per-(bot, field) sub-seeding: each attribute of each bot draws from its
 *     OWN stream, derived as hash(masterSeed, botIndex, fieldName). This isolates
 *     variable-length consumption (rejection loops, affinity lists) so a change
 *     to one attribute's logic can never shift another attribute — of the same
 *     bot OR of any other bot. Adjacent-integer seeds are NEVER fed to the weak
 *     PRNG directly (they produce correlated early outputs); every seed passes
 *     through the xmur3 mixing hash first.
 *
 * mulberry32 is a small, fast, well-distributed 32-bit generator — ample for
 * name/attribute sampling and identical across platforms (pure integer math).
 */

export type Rng = () => number;

/** xmur3 string hash → 32-bit seed generator. Good avalanche for our keys. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32: deterministic uniform in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Derive an independent RNG stream from a stable string key. The key is mixed
 * through xmur3 (two rounds folded together) before seeding mulberry32, so
 * lexically-close keys ("bot:0:name" vs "bot:1:name") yield uncorrelated
 * streams.
 */
export function rngFromKey(key: string): Rng {
  const gen = xmur3(key);
  const s = (gen() ^ gen()) >>> 0;
  return mulberry32(s);
}

/** Per-(bot, field) stream: hash(masterSeed, botIndex, field). */
export function fieldRng(masterSeed: number, botIndex: number, field: string): Rng {
  return rngFromKey(`${masterSeed >>> 0}:${botIndex}:${field}`);
}

/** A stable bigint personality seed in the JS safe-integer range (< 2^53). */
export function personalitySeed(masterSeed: number, botIndex: number): bigint {
  const rng = fieldRng(masterSeed, botIndex, 'personality');
  // 52 bits of entropy assembled from two 26-bit halves; strictly < 2^52.
  const hi = Math.floor(rng() * (1 << 26));
  const lo = Math.floor(rng() * (1 << 26));
  return (BigInt(hi) << 26n) | BigInt(lo);
}

// ---- sampling helpers (all consume from a provided Rng) ----

/** Uniform integer in [min, max] inclusive. */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Uniform pick from a non-empty array. */
export function pick<T>(rng: Rng, arr: readonly T[]): T {
  if (arr.length === 0) throw new Error('pick() from empty array');
  return arr[Math.floor(rng() * arr.length)]!;
}

/** True with probability p. */
export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}

/**
 * Weighted pick. `weights[i]` is the relative weight of `items[i]`. Weights need
 * not sum to 1. Consumes exactly one draw.
 */
export function weightedPick<T>(rng: Rng, items: readonly T[], weights: readonly number[]): T {
  if (items.length === 0 || items.length !== weights.length) {
    throw new Error('weightedPick(): items/weights length mismatch or empty');
  }
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error('weightedPick(): non-positive total weight');
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!;
    if (r < 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

/**
 * Sample a value by empirical quantiles. `quantiles` is a sorted list of
 * [cumulativeProbability, value] knots; returns the value of the first knot
 * whose cumulative probability exceeds the draw. Use for skewed distributions
 * (e.g. daily match cap) where fitting a parametric shape would distort the tail.
 */
export function quantileSample(rng: Rng, quantiles: readonly [number, number][]): number {
  const r = rng();
  for (const [cum, value] of quantiles) {
    if (r <= cum) return value;
  }
  return quantiles[quantiles.length - 1]![1];
}
