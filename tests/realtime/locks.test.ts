import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No Redis in unit tests → locks.ts uses its in-process localLocks fallback,
// where TTL is enforced by a setTimeout. With fake timers we can advance time
// and assert the heartbeat keeps the lock alive past its original TTL.
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => null }));

import {
  acquireLock,
  releaseLock,
  extendLock,
  startLockHeartbeat,
} from '../../src/realtime/locks.js';

describe('startLockHeartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps a held lock alive past its original TTL until stop()', async () => {
    const key = `lock:test:${Math.floor(Math.random() * 1e9)}`;
    const ttl = 15_000;
    const lock = await acquireLock(key, ttl);
    expect(lock.acquired).toBe(true);

    const hb = startLockHeartbeat(key, lock.token!, ttl);

    // Advance well past the original TTL; the heartbeat (every ttl/3) renews it.
    await vi.advanceTimersByTimeAsync(ttl * 3);

    // Lock is still held — a fresh acquire must fail.
    const contender = await acquireLock(key, ttl);
    expect(contender.acquired, 'lock must still be held while heartbeat runs').toBe(false);

    // Stop the heartbeat, let the current TTL lapse → lock frees.
    hb.stop();
    await vi.advanceTimersByTimeAsync(ttl + 1);
    const afterStop = await acquireLock(key, ttl);
    expect(afterStop.acquired, 'lock must free after heartbeat stops and TTL lapses').toBe(true);
    await releaseLock(key, afterStop.token!);
  });

  it('is a harmless no-op once the lock is released (token no longer matches)', async () => {
    const key = `lock:test:${Math.floor(Math.random() * 1e9)}`;
    const ttl = 9_000;
    const lock = await acquireLock(key, ttl);
    const hb = startLockHeartbeat(key, lock.token!, ttl);

    await releaseLock(key, lock.token!); // release while heartbeat still ticking
    // extendLock with the old token must not resurrect the lock.
    const extended = await extendLock(key, lock.token!, ttl);
    expect(extended).toBe(false);

    hb.stop();
  });
});
