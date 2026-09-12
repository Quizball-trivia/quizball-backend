import { beforeEach, describe, expect, it, vi } from 'vitest';

const guestRepo = { listIdleIds: vi.fn(), retireSession: vi.fn() };
const invalidateUser = vi.fn();
const disconnectUserSockets = vi.fn();
vi.mock('../../src/modules/guest/guest.repo.js', () => ({ guestRepo }));
vi.mock('../../src/modules/guest/guest.service.js', () => ({ GUEST_PURGE_DAYS: 45 }));
vi.mock('../../src/modules/users/user-cache.js', () => ({ invalidateUser: (...a: unknown[]) => invalidateUser(...a) }));
vi.mock('../../src/realtime/services/auth-realtime.service.js', () => ({ disconnectUserSockets: (...a: unknown[]) => disconnectUserSockets(...a) }));
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { sweepIdleGuests } = await import('../../src/modules/guest/guest.sweeper.js');

describe('guest sweeper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateUser.mockResolvedValue(undefined);
    disconnectUserSockets.mockResolvedValue(undefined);
  });

  it('retires each session atomically (tombstone + identity + session), then evicts the cache and disconnects', async () => {
    guestRepo.listIdleIds.mockResolvedValueOnce(['s-played', 's-daily-only']).mockResolvedValue([]);
    guestRepo.retireSession.mockImplementation(async (s: string) => ({ userId: s === 's-played' ? 'u-1' : null }));
    const result = await sweepIdleGuests(45);
    expect(result).toEqual({ sessions: 2, tombstoned: 1 });
    expect(guestRepo.retireSession.mock.calls.map((c) => c[0])).toEqual(['s-played', 's-daily-only']);
    expect(guestRepo.retireSession).toHaveBeenCalledWith('s-played', 'guest');
    expect(invalidateUser).toHaveBeenCalledWith('guest', 's-played', 'u-1');
    expect(disconnectUserSockets).toHaveBeenCalledWith('u-1', 'guest_expired');
    expect(disconnectUserSockets).toHaveBeenCalledTimes(1);
  });

  it('a failed retirement keeps the session (nothing partial is committed) and the sweep continues', async () => {
    guestRepo.listIdleIds.mockResolvedValueOnce(['s-bad', 's-ok']).mockResolvedValue([]);
    guestRepo.retireSession.mockImplementation(async (s: string) => {
      if (s === 's-bad') throw new Error('db down');
      return { userId: 'u-ok' };
    });
    const result = await sweepIdleGuests(45);
    expect(result).toEqual({ sessions: 1, tombstoned: 1 });
    expect(disconnectUserSockets).toHaveBeenCalledWith('u-ok', 'guest_expired');
  });

  it('drains a backlog in batches and stops when a whole batch fails', async () => {
    const batch = (prefix: string) => Array.from({ length: 500 }, (_, i) => `${prefix}-${i}`);
    guestRepo.listIdleIds
      .mockResolvedValueOnce(batch('a'))
      .mockResolvedValueOnce(batch('b'))
      .mockResolvedValueOnce(['c-1'])
      .mockResolvedValue([]);
    guestRepo.retireSession.mockResolvedValue({ userId: null });
    expect(await sweepIdleGuests(45)).toEqual({ sessions: 1001, tombstoned: 0 });
    expect(guestRepo.listIdleIds).toHaveBeenCalledTimes(3);

    vi.clearAllMocks();
    guestRepo.listIdleIds.mockResolvedValue(batch('x'));
    guestRepo.retireSession.mockRejectedValue(new Error('db down'));
    expect(await sweepIdleGuests(45)).toEqual({ sessions: 0, tombstoned: 0 });
    expect(guestRepo.listIdleIds).toHaveBeenCalledTimes(1);
  });
});
