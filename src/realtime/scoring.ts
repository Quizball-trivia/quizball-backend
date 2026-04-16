/**
 * Shared scoring utilities used by both classic and possession match engines.
 */

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Calculate points for a round answer.
 * Faster correct answers earn more points (10 per remaining second).
 */
export function calculatePoints(isCorrect: boolean, timeMs: number, questionTimeMs: number): number {
  if (!isCorrect) return 0;
  const clamped = clamp(timeMs, 0, questionTimeMs);
  const remainingMs = Math.max(0, questionTimeMs - clamped);
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
