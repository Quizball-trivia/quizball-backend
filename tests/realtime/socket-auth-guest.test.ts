import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseVerify = vi.fn();
const guestVerify = vi.fn();
const getOrCreateFromIdentity = vi.fn();
const getOrCreateGuest = vi.fn();
vi.mock('../../src/modules/auth/index.js', () => ({ getAuthProvider: () => ({ verifyToken: supabaseVerify }) }));
vi.mock('../../src/modules/auth/guest-auth-provider.js', () => ({
  GuestAuthProvider: { handles: (token: string) => /^[a-f0-9]{64}$/.test(token) },
  getGuestAuthProvider: () => ({ verifyToken: guestVerify }),
}));
vi.mock('../../src/modules/users/index.js', () => ({ usersService: { getOrCreateFromIdentity, getOrCreateGuest } }));
vi.mock('../../src/modules/users/user-cache.js', () => ({ getCachedUser: vi.fn().mockResolvedValue(null) }));
vi.mock('../../src/realtime/session-country.js', () => ({ rememberCurrentCountry: vi.fn() }));
vi.mock('../../src/core/geo.js', () => ({ detectCountryFromHeaders: vi.fn().mockResolvedValue(null) }));
vi.mock('../../src/core/tracing.js', () => ({
  withSpan: async (_n: string, _a: unknown, work: (span: { setAttribute: () => void }) => unknown) => work({ setAttribute: vi.fn() }),
}));

// The real config object (zod output) is mutable; flip only the two guest flags per test.
const { config } = await import('../../src/core/config.js');
const flags = config as unknown as { GUEST_LOBBIES_PROVISIONING_ENABLED: boolean; GUEST_LOBBIES_RECONNECT_ENABLED: boolean };
const GUEST_TOKEN = 'd'.repeat(64);
const socketFor = (token: string) => ({ id: 's', handshake: { auth: { token }, headers: {}, address: '127.0.0.1' }, data: {} as Record<string, unknown> });

describe('socketAuthMiddleware — guest tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.GUEST_LOBBIES_PROVISIONING_ENABLED = false;
    flags.GUEST_LOBBIES_RECONNECT_ENABLED = false;
    guestVerify.mockResolvedValue({ provider: 'guest', subject: 'g-1', claims: {} });
    getOrCreateGuest.mockResolvedValue({ user: { id: 'u-guest', is_guest: true }, created: true });
    supabaseVerify.mockResolvedValue({ provider: 'supabase', subject: 'sub', claims: {} });
    getOrCreateFromIdentity.mockResolvedValue({ id: 'u-member' });
  });

  it('refuses guest tokens outright while both flags are off, before any lookup', async () => {
    const { socketAuthMiddleware } = await import('../../src/realtime/socket-auth.js');
    const next = vi.fn();
    await socketAuthMiddleware(socketFor(GUEST_TOKEN) as never, next);
    expect(next.mock.calls[0]?.[0]?.message).toBe('Authentication required');
    expect(guestVerify).not.toHaveBeenCalled();
    expect(getOrCreateGuest).not.toHaveBeenCalled();
  });

  it('provisions a guest through the guest provider, never the Supabase one', async () => {
    flags.GUEST_LOBBIES_PROVISIONING_ENABLED = true;
    const { socketAuthMiddleware } = await import('../../src/realtime/socket-auth.js');
    const next = vi.fn();
    const socket = socketFor(GUEST_TOKEN);
    await socketAuthMiddleware(socket as never, next);
    expect(next).toHaveBeenCalledWith();
    expect(supabaseVerify).not.toHaveBeenCalled();
    expect(getOrCreateFromIdentity).not.toHaveBeenCalled();
    expect(getOrCreateGuest).toHaveBeenCalledWith({ provider: 'guest', subject: 'g-1', claims: {} }, null, { allowCreate: true });
    expect((socket.data.user as { id: string }).id).toBe('u-guest');
  });

  it('drain: with provisioning off and reconnect on, an existing guest gets back in and a new one does not', async () => {
    flags.GUEST_LOBBIES_RECONNECT_ENABLED = true;
    getOrCreateGuest.mockResolvedValueOnce({ user: { id: 'u-guest', is_guest: true }, created: false });
    const { socketAuthMiddleware } = await import('../../src/realtime/socket-auth.js');
    const next = vi.fn();
    await socketAuthMiddleware(socketFor(GUEST_TOKEN) as never, next);
    expect(next).toHaveBeenCalledWith();
    expect(getOrCreateGuest).toHaveBeenLastCalledWith(expect.anything(), null, { allowCreate: false });
  });

  it('drain the other way: provisioning on, reconnect off — a returning guest is refused', async () => {
    flags.GUEST_LOBBIES_PROVISIONING_ENABLED = true;
    getOrCreateGuest.mockResolvedValueOnce({ user: { id: 'u-guest', is_guest: true }, created: false });
    const { socketAuthMiddleware } = await import('../../src/realtime/socket-auth.js');
    const next = vi.fn();
    await socketAuthMiddleware(socketFor(GUEST_TOKEN) as never, next);
    expect(next.mock.calls[0]?.[0]?.message).toBe('Authentication required');
  });

  it('members are untouched by the guest flags', async () => {
    const { socketAuthMiddleware } = await import('../../src/realtime/socket-auth.js');
    const next = vi.fn();
    await socketAuthMiddleware(socketFor('member-jwt') as never, next);
    expect(next).toHaveBeenCalledWith();
    expect(getOrCreateFromIdentity).toHaveBeenCalled();
    expect(guestVerify).not.toHaveBeenCalled();
  });
});
