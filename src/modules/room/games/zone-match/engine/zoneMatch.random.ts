// COPY of the web's src/features/zone-match/zoneMatch.random.ts (one rules implementation; keep byte-identical apart from import paths).
/**
 * The engine's one source of chance. In the browser it is Math.random; the server runs every reducer step inside
 * `withRandom(seed, …)`, so a match replays exactly from its seed and commands (and no client can predict it).
 */

let source: () => number = Math.random;

export const rand = (): number => source();

/** A small, fast seeded generator (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs `fn` with chance drawn from `seed` (synchronous only: the previous source is restored after). */
export function withRandom<T>(seed: number, fn: () => T): T {
  const previous = source;
  source = seeded(seed);
  try {
    return fn();
  } finally {
    source = previous;
  }
}
