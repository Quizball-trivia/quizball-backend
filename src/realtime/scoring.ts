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
