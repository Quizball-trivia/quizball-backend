import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const acquireLockMock = vi.hoisted(() => vi.fn());
const extendLockMock = vi.hoisted(() => vi.fn());
const releaseLockMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: (...args: unknown[]) => acquireLockMock(...args),
  extendLock: (...args: unknown[]) => extendLockMock(...args),
  releaseLock: (...args: unknown[]) => releaseLockMock(...args),
}));
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => ({ isOpen: true }) }));

import { withAnswerLock } from '../../src/realtime/possession-answer-lock.js';

describe('withAnswerLock lease tracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    acquireLockMock.mockResolvedValue({ acquired: true, token: 'tok' });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes leaseLost() to the critical section: false while renewals succeed, true once extendLock returns false', async () => {
    extendLockMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const seen: boolean[] = [];
    const result = await withAnswerLock('m1', 'round', () => undefined, async (lease) => {
      seen.push(lease.leaseLost());
      await vi.advanceTimersByTimeAsync(1_100); // first renewal: ok
      seen.push(lease.leaseLost());
      await vi.advanceTimersByTimeAsync(1_100); // second renewal: lost
      seen.push(lease.leaseLost());
      return 'done';
    });
    expect(result).toBe('done');
    expect(seen).toEqual([false, false, true]);
    expect(releaseLockMock).toHaveBeenCalledWith('lock:match:m1:round', 'tok');
  });

  it('treats a throwing extendLock as a lost lease', async () => {
    extendLockMock.mockRejectedValue(new Error('redis down'));
    await withAnswerLock('m1', 'round', () => undefined, async (lease) => {
      await vi.advanceTimersByTimeAsync(1_100);
      expect(lease.leaseLost()).toBe(true);
    });
  });
});
