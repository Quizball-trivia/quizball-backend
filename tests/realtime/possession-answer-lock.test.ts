import { beforeEach, describe, expect, it, vi } from 'vitest';

const acquireLockMock = vi.hoisted(() => vi.fn());
const extendLockMock = vi.hoisted(() => vi.fn(async () => true));
const releaseLockMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: (...args: unknown[]) => acquireLockMock(...args),
  extendLock: (...args: unknown[]) => extendLockMock(...args),
  releaseLock: (...args: unknown[]) => releaseLockMock(...args),
}));

import { withAnswerLock } from '../../src/realtime/possession-answer-lock.js';

describe('withAnswerLock', () => {
  beforeEach(() => {
    acquireLockMock.mockReset();
    extendLockMock.mockClear();
    releaseLockMock.mockClear();
  });

  it('waits through a short competing answer instead of dropping the submission', async () => {
    acquireLockMock
      .mockResolvedValueOnce({ acquired: false })
      .mockResolvedValueOnce({ acquired: false })
      .mockResolvedValueOnce({ acquired: true, token: 'ours' });
    const onBusy = vi.fn();
    const work = vi.fn(async () => 'committed');

    await expect(withAnswerLock('match-1', 'answer', onBusy, work)).resolves.toBe('committed');

    expect(acquireLockMock).toHaveBeenCalledTimes(3);
    expect(onBusy).not.toHaveBeenCalled();
    expect(work).toHaveBeenCalledOnce();
    expect(releaseLockMock).toHaveBeenCalledWith('lock:match:match-1:answer', 'ours');
  });

  it('still sheds after the bounded wait when the lock remains busy', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 250;
      return now;
    });
    acquireLockMock.mockResolvedValue({ acquired: false });
    const onBusy = vi.fn();
    const work = vi.fn(async () => 'never');

    await expect(withAnswerLock('match-2', 'answer', onBusy, work)).resolves.toBeUndefined();

    expect(onBusy).toHaveBeenCalledOnce();
    expect(work).not.toHaveBeenCalled();
    expect(releaseLockMock).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
