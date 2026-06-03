/**
 * Harness fast-timing seam.
 *
 * The regression harness runs real matches in real (not faked) time, but the
 * production matchmaking/draft delays (queue search 7s, AI search ~7s, draft
 * auto-ban 16s) would make every match take ~35s. When REGRESSION_FAST_TIMERS=1
 * (only ever set locally, alongside REGRESSION_DETERMINISTIC), these collapse to
 * a few ms so thousands of matches are feasible. Production is untouched.
 *
 * Guarded the same way as REGRESSION_DETERMINISTIC (config refuses to boot if set
 * outside local — see core/config.ts).
 */
const FAST = process.env.REGRESSION_FAST_TIMERS === '1';

/**
 * Returns `fastMs` when harness fast-timers are on, else the real `prodMs`.
 * Default fast value is 200ms (> the 100ms matchmaking tick interval) so the
 * queue/draft deadlines are popped on the NEXT tick rather than racing the
 * record write — a too-small value (e.g. 5ms) can expire before the search row
 * is queryable and the fallback never fires.
 */
export function harnessDelayMs(prodMs: number, fastMs = 200): number {
  return FAST ? fastMs : prodMs;
}

export function isHarnessFastTimers(): boolean {
  return FAST;
}
