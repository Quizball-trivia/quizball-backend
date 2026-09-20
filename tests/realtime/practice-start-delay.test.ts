import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/config.js', () => ({
  config: { GUEST_BOT_MATCH_DELAY_MIN_MS: 5_000, GUEST_BOT_MATCH_DELAY_MAX_MS: 25_000 },
}));

import {
  attachPracticeSearchId, beginPracticeStart, cancelPracticeStart, claimPracticeSeating, finishPracticeStart,
  isPracticeStartCurrent, practiceStartDelayMs, waitForPracticeStart,
} from '../../src/realtime/services/practice-start-delay.js';

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

  it('resolves after the wait and stays current until finished, so a late cancel still invalidates it', async () => {
    const token = beginPracticeStart('grid:u1');
    const wait = waitForPracticeStart('grid:u1', token, 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(wait).resolves.toBe(true);
    expect(isPracticeStartCurrent('grid:u1', token)).toBe(true);
    expect(cancelPracticeStart('grid:u1')).toBe('cancelled');
    expect(isPracticeStartCurrent('grid:u1', token)).toBe(false);
    finishPracticeStart('grid:u1', token);
  });

  it('a newer start supersedes the older one, even before the older one started waiting', async () => {
    const older = beginPracticeStart('auction:u1');
    const newer = beginPracticeStart('auction:u1');
    await expect(waitForPracticeStart('auction:u1', older, 10_000)).resolves.toBe(false);
    expect(isPracticeStartCurrent('auction:u1', older)).toBe(false);
    const wait = waitForPracticeStart('auction:u1', newer, 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(wait).resolves.toBe(true);
    finishPracticeStart('auction:u1', newer);
    expect(isPracticeStartCurrent('auction:u1', newer)).toBe(false);
  });

  it('cancels only the matching search id; a stale cancel leaves the newer search alone', async () => {
    const token = beginPracticeStart('grid:u2');
    // Before the search id is announced, a cancel naming a search can only be stale.
    expect(cancelPracticeStart('grid:u2', 'search-old')).toBe('mismatch');
    expect(isPracticeStartCurrent('grid:u2', token)).toBe(true);
    attachPracticeSearchId('grid:u2', token, 'search-b');
    const wait = waitForPracticeStart('grid:u2', token, 10_000);
    expect(cancelPracticeStart('grid:u2', 'search-a')).toBe('mismatch');
    expect(isPracticeStartCurrent('grid:u2', token)).toBe(true);
    expect(cancelPracticeStart('grid:u2', 'search-b')).toBe('cancelled');
    await expect(wait).resolves.toBe(false);
    expect(cancelPracticeStart('grid:u2')).toBe('none');
  });

  it('a start that claimed its seating can no longer be cancelled', () => {
    const token = beginPracticeStart('grid:u3');
    expect(claimPracticeSeating('grid:u3', token)).toBe(true);
    expect(cancelPracticeStart('grid:u3')).toBe('committed');
    expect(isPracticeStartCurrent('grid:u3', token)).toBe(true);
    finishPracticeStart('grid:u3', token);
    expect(claimPracticeSeating('grid:u3', token)).toBe(false);
  });
});
