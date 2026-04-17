/**
 * Shared scoring utilities used by both classic and possession match engines.
 */

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * GRACE_MS: any correct answer with elapsed time ≤ GRACE_MS earns full points.
 * Covers typical RTT + reaction so "instant" clicks reliably hit the max.
 */
const GRACE_MS = 300;

/**
 * Calculate points for a round answer.
 * Stepped 10-point buckets based on remaining seconds (100, 90, 80, …, 10, 0)
 * with a GRACE_MS full-points window at the start so the top bucket is reachable
 * despite network latency.
 */
export function calculatePoints(isCorrect: boolean, timeMs: number, questionTimeMs: number): number {
  if (!isCorrect) return 0;
  const clamped = clamp(timeMs, 0, questionTimeMs);
  const effectiveTime = Math.max(0, clamped - GRACE_MS);
  const remainingMs = Math.max(0, questionTimeMs - effectiveTime);
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  return remainingSeconds * 10;
}

/**
 * Calculate countdown round points based on how many answer groups were found.
 * Points are proportional to the fraction found, capped at 100.
 */
export function calculateCountdownScore(foundCount: number, totalGroups: number): number {
  if (totalGroups <= 0) return 0;
  return Math.round((foundCount / totalGroups) * 100);
}
