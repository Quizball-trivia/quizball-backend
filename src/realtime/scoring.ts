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
 * Points are proportional to the fraction found, capped at 100, and rounded to
 * clean 5-point buckets so live special rounds show readable values like 15,
 * 25, 30 instead of odd numbers like 13 or 27.
 */
export function calculateCountdownScore(foundCount: number, totalGroups: number): number {
  if (totalGroups <= 0) return 0;
  const rawScore = (clamp(foundCount, 0, totalGroups) / totalGroups) * 100;
  return clamp(Math.round(rawScore / 5) * 5, 0, 100);
}

/**
 * Calculate put-in-order points from positions that match the correct order.
 * Each matched position is worth 20 points, capped at 100.
 */
export function calculatePutInOrderScore(matchedPositions: number, totalItems: number): number {
  if (totalItems <= 0) return 0;
  return Math.min(clamp(matchedPositions, 0, totalItems) * 20, 100);
}

/**
 * Calculate who-am-I points from the clue that produced the correct answer.
 * Clue 1 is the maximum score, then each later clue steps down. Scores are
 * capped at 100 so clues cannot create oversized bar battles or possession
 * swings compared with the other special question types.
 */
export function calculateCluesScore(isCorrect: boolean, clueIndex: number): number {
  if (!isCorrect) return 0;
  const normalizedIndex = Math.max(0, Math.floor(clueIndex));
  return Math.max(20, 100 - normalizedIndex * 20);
}
