import { createHmac, randomBytes } from 'node:crypto';

export const newSeed = (): string => randomBytes(16).toString('hex');

/**
 * Deterministic draws for a match: the n-th draw is HMAC(seed, n). The counter is persisted with the
 * state, so a retried transaction replays the same draws instead of rerolling them.
 */
export function seededRng(seed: string, start: number): { rng: () => number; used: () => number } {
  let counter = start;
  return {
    rng: () => {
      const digest = createHmac('sha256', seed).update(String(counter)).digest();
      counter += 1;
      return digest.readUIntBE(0, 6) / 2 ** 48;
    },
    used: () => counter,
  };
}
