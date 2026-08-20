import type { ChoreographyStep } from './guess-the-goal.types.js';

/**
 * Server-side port of the client replay clock (frontend
 * src/features/mini-games/lib/tacticsEngine.ts buildTimeline): main steps run
 * sequentially, withPrev steps share their predecessor's start. Scoring maps
 * server-elapsed seconds to "how many main moves had been revealed", so a
 * client cannot claim an earlier guess than its wall-clock allows.
 */
export interface ChoreographyTimings {
  /** Start time (s) of each main (non-withPrev) step, in order. */
  mainStarts: number[];
  /** Total replay duration in seconds. */
  duration: number;
}

export function buildTimings(steps: ChoreographyStep[]): ChoreographyTimings {
  const mainStarts: number[] = [];
  let cursor = 0;
  let lastMainStart = 0;

  for (const step of steps) {
    const start = step.withPrev ? lastMainStart : cursor;
    const end = start + step.duration;
    if (!step.withPrev) {
      lastMainStart = start;
      mainStarts.push(start);
    }
    cursor = Math.max(cursor, end);
  }

  return { mainStarts, duration: cursor };
}

/** Number of main moves revealed after `elapsedSeconds` (≥ 1 once started). */
export function revealedMovesAt(timings: ChoreographyTimings, elapsedSeconds: number): number {
  let revealed = 0;
  for (const start of timings.mainStarts) {
    if (start <= elapsedSeconds) revealed += 1;
  }
  return Math.max(1, revealed);
}

/** Linear decay MAX→MIN by revealed main moves; past full reveal stays at MIN. */
export function pointsForReveal(
  revealed: number,
  mainCount: number,
  maxPoints: number,
  minPoints: number
): number {
  const step = Math.max(0, Math.min(revealed - 1, mainCount - 1));
  const span = Math.max(1, mainCount - 1);
  const raw = Math.round(maxPoints - ((maxPoints - minPoints) * step) / span);
  return Math.max(minPoints, Math.min(maxPoints, raw));
}
