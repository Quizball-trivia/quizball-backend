/**
 * Controllable clock for the in-process match harness.
 *
 * The engine reads time from FOUR places, and a faithful match replay must drive
 * ALL of them in the right order:
 *   1. wall clock — raw Date.now() / new Date() (32 sites across the engine)
 *   2. JS timers — setTimeout (resume countdown, AI nuance delays, grace fallback)
 *   3. JS intervals — setInterval (the durable realtime-timer scheduler poll AND
 *      the ranked matchmaking rankedTick loop)
 *   4. the durable Redis timer ZSET (realtime:timers) — popped by the scheduler
 *      poll, which compares stored scores against Date.now()
 *
 * vitest fake timers mock (1)+(2)+(3) globally; advancing them re-reads the faked
 * Date.now() that (4) also compares against. So a single `advance()` that calls
 * vi.advanceTimersByTimeAsync covers everything: it moves the clock, fires due
 * setTimeouts/intervals (scheduler poll + matchmaking tick), and flushes the
 * microtasks those handlers await — repeatedly until the window is consumed.
 *
 * This module is consumed from a vitest test (where fake timers exist). It does
 * NOT import vitest itself — the caller injects the `vi` fake-timer surface so
 * this stays a plain module and the engine code never sees vitest.
 */

export interface FakeTimerApi {
  advanceTimersByTimeAsync: (ms: number) => Promise<void>;
  runOnlyPendingTimersAsync?: () => Promise<void>;
}

export interface HarnessClock {
  /**
   * Advance fake time by `ms`, in small steps, firing all due timers/intervals and
   * flushing microtasks between steps. Small steps matter: a single large jump can
   * skip ordering between the scheduler poll (every ~500ms) and timers that should
   * fire in between. `stepMs` defaults to the scheduler poll interval.
   */
  advance: (ms: number, stepMs?: number) => Promise<void>;
  /** Advance until `predicate()` is true or `maxMs` elapses. Returns true if met. */
  advanceUntil: (predicate: () => boolean | Promise<boolean>, maxMs: number, stepMs?: number) => Promise<boolean>;
}

const DEFAULT_STEP_MS = 250; // < scheduler poll (500ms) so no poll is skipped

async function flushMicrotasks(): Promise<void> {
  // Let awaited promises chained off timer handlers settle before the next step.
  await Promise.resolve();
  await Promise.resolve();
}

export function createHarnessClock(vi: FakeTimerApi): HarnessClock {
  async function advance(ms: number, stepMs: number = DEFAULT_STEP_MS): Promise<void> {
    let remaining = ms;
    const step = Math.max(1, Math.min(stepMs, ms || 1));
    while (remaining > 0) {
      const delta = Math.min(step, remaining);
      await vi.advanceTimersByTimeAsync(delta);
      await flushMicrotasks();
      remaining -= delta;
    }
  }

  async function advanceUntil(
    predicate: () => boolean | Promise<boolean>,
    maxMs: number,
    stepMs: number = DEFAULT_STEP_MS,
  ): Promise<boolean> {
    let elapsed = 0;
    if (await predicate()) return true;
    while (elapsed < maxMs) {
      const delta = Math.min(stepMs, maxMs - elapsed);
      await vi.advanceTimersByTimeAsync(delta);
      await flushMicrotasks();
      elapsed += delta;
      if (await predicate()) return true;
    }
    return false;
  }

  return { advance, advanceUntil };
}
