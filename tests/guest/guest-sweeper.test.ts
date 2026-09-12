import { beforeEach, describe, expect, it, vi } from 'vitest';

const guestRepo = { listIdleIds: vi.fn(), deleteByIds: vi.fn() };
const identitiesRepo = { deleteByProviderSubject: vi.fn() };
const usersRepo = { tombstoneGuest: vi.fn() };
const invalidateUser = vi.fn();
const disconnectUserSockets = vi.fn();
vi.mock('../../src/modules/guest/guest.repo.js', () => ({ guestRepo }));
vi.mock('../../src/modules/guest/guest.service.js', () => ({ GUEST_PURGE_DAYS: 45 }));
vi.mock('../../src/modules/users/identities.repo.js', () => ({ identitiesRepo }));
vi.mock('../../src/modules/users/users.repo.js', () => ({ usersRepo }));
vi.mock('../../src/modules/users/user-cache.js', () => ({ invalidateUser: (...a: unknown[]) => invalidateUser(...a) }));
vi.mock('../../src/realtime/services/auth-realtime.service.js', () => ({ disconnectUserSockets: (...a: unknown[]) => disconnectUserSockets(...a) }));
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { sweepIdleGuests } = await import('../../src/modules/guest/guest.sweeper.js');

describe('guest sweeper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guestRepo.deleteByIds.mockResolvedValue(1);
    usersRepo.tombstoneGuest.mockResolvedValue(true);
    invalidateUser.mockResolvedValue(undefined);
    disconnectUserSockets.mockResolvedValue(undefined);
  });

  it('tombstones the users row, revokes the identity, evicts the cache and disconnects, then deletes the session', async () => {
    guestRepo.listIdleIds.mockResolvedValue(['s-played', 's-daily-only']);
    identitiesRepo.deleteByProviderSubject.mockImplementation(async (_p: string, s: string) => (s === 's-played' ? 'u-1' : null));
    const result = await sweepIdleGuests(45);
    expect(result).toEqual({ sessions: 2, tombstoned: 1 });
    expect(usersRepo.tombstoneGuest).toHaveBeenCalledWith('u-1');
    expect(invalidateUser).toHaveBeenCalledWith('guest', 's-played', 'u-1');
    expect(disconnectUserSockets).toHaveBeenCalledWith('u-1', 'guest_expired');
    expect(guestRepo.deleteByIds.mock.calls.map((c) => c[0])).toEqual([['s-played'], ['s-daily-only']]);
  });

  it('keeps a session whose tombstone failed so the next pass retries it', async () => {
    guestRepo.listIdleIds.mockResolvedValue(['s-1']);
    identitiesRepo.deleteByProviderSubject.mockRejectedValue(new Error('db down'));
    await sweepIdleGuests(45);
    expect(guestRepo.deleteByIds).not.toHaveBeenCalled();
  });
});
