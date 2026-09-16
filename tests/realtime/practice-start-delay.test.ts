import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/config.js', () => ({
  config: { GUEST_BOT_MATCH_DELAY_MIN_MS: 5_000, GUEST_BOT_MATCH_DELAY_MAX_MS: 25_000 },
}));

import { cancelPracticeStart, practiceStartDelayMs, waitForPracticeStart } from '../../src/realtime/services/practice-start-delay.js';

describe('practice start delay', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('draws a wait inside the configured window', () => {
    for (let i = 0; i < 50; i += 1) {
      const ms = practiceStartDelayMs();
      expect(ms).toBeGreaterThanOrEqual(5_000);
      expect(ms).toBeLessThanOrEqual(25_000);
    }
  });

  it('resolves true after the wait, false when cancelled, and a newer start supersedes the older one', async () => {
    const first = waitForPracticeStart('grid:u1', 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(first).resolves.toBe(true);

    const cancelled = waitForPracticeStart('grid:u1', 10_000);
    expect(cancelPracticeStart('grid:u1')).toBe(true);
    await expect(cancelled).resolves.toBe(false);
    expect(cancelPracticeStart('grid:u1')).toBe(false);

    const older = waitForPracticeStart('auction:u1', 10_000);
    const newer = waitForPracticeStart('auction:u1', 10_000);
    await expect(older).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(newer).resolves.toBe(true);
  });
});
