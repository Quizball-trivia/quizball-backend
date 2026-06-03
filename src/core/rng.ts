import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Deterministic-RNG seam.
 *
 * Production code calls `getRandom()` instead of `Math.random()` directly. By
 * default it IS `Math.random` — prod behaviour is unchanged. Tests (and the game
 * regression harness) run code inside `withSeed(seed, fn)` so every `getRandom()`
 * call within that async scope draws from a seeded, reproducible PRNG. This makes
 * a whole match replayable without making prod deterministic.
 *
 * The scope is held in AsyncLocalStorage (same pattern as request-context.ts), so
 * concurrent matches each see their OWN seeded stream — no shared global mutable
 * seed that would cross-contaminate parallel runs.
 */

interface RngScope {
  next: () => number;
}

const rngStorage = new AsyncLocalStorage<RngScope>();

/**
 * mulberry32 — a tiny, fast, well-distributed 32-bit PRNG. Deterministic given a
 * seed; good enough for test reproducibility (not cryptographic).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive a stable numeric seed from a string (e.g. a matchId) or a number. */
export function seedFrom(value: string | number): number {
  if (typeof value === 'number') return value >>> 0;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The single random source the engine should use. Returns a float in [0, 1).
 * Inside a `withSeed` scope → seeded/deterministic. Outside (prod) → `Math.random`.
 */
export function getRandom(): number {
  const scope = rngStorage.getStore();
  return scope ? scope.next() : Math.random();
}

/**
 * Run `fn` with a seeded RNG scope. Every `getRandom()` call made synchronously or
 * asynchronously within `fn` draws from the seeded stream. Nested/concurrent calls
 * with different seeds are isolated by AsyncLocalStorage.
 */
export function withSeed<T>(seed: string | number, fn: () => T): T {
  return rngStorage.run({ next: mulberry32(seedFrom(seed)) }, fn);
}

/** True if the current async context is running inside a seeded RNG scope. */
export function isSeeded(): boolean {
  return rngStorage.getStore() !== undefined;
}
