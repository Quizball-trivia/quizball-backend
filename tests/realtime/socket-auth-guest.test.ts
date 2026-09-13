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
    flags.GUEST_LOBBIES_RECONNECT_ENABLED = true;
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

  it('reconnect off refuses every guest token before any lookup, even with provisioning on', async () => {
    flags.GUEST_LOBBIES_PROVISIONING_ENABLED = true;
    const { socketAuthMiddleware } = await import('../../src/realtime/socket-auth.js');
    const next = vi.fn();
    await socketAuthMiddleware(socketFor(GUEST_TOKEN) as never, next);
    expect(next.mock.calls[0]?.[0]?.message).toBe('Authentication required');
    expect(guestVerify).not.toHaveBeenCalled();
    expect(getOrCreateGuest).not.toHaveBeenCalled();
  });

  it('a banned guest is refused with the ban reason (the users service throws like it does for members)', async () => {
    flags.GUEST_LOBBIES_RECONNECT_ENABLED = true;
    const { AppError } = await import('../../src/core/errors.js');
    getOrCreateGuest.mockRejectedValueOnce(new AppError('Account is banned', 403, 'FORBIDDEN' as never, { reason: 'banned' }));
    const { socketAuthMiddleware } = await import('../../src/realtime/socket-auth.js');
    const next = vi.fn();
    await socketAuthMiddleware(socketFor(GUEST_TOKEN) as never, next);
    expect(next.mock.calls[0]?.[0]?.message).toBe('Account is banned');
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

describe('socketIpBucket — trusted-edge address policy', () => {
  const env = config as unknown as { NODE_ENV: string };
  const original = env.NODE_ENV;
  const socketWith = (headers: Record<string, string>, address = '10.0.0.7') => ({ handshake: { headers, address } });

  it('local: the transport address, never a header', async () => {
    env.NODE_ENV = 'local';
    const { socketIpBucket } = await import('../../src/realtime/socket-auth.js');
    expect(socketIpBucket(socketWith({ 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '8.8.8.8' }, '::ffff:192.168.1.5') as never)).toBe('192.168.1.5');
    env.NODE_ENV = original;
  });

  it('deployed: only X-Real-IP counts; a caller-controlled X-Forwarded-For cannot rotate the key', async () => {
    env.NODE_ENV = 'staging';
    const { socketIpBucket } = await import('../../src/realtime/socket-auth.js');
    expect(socketIpBucket(socketWith({ 'x-forwarded-for': '9.9.9.9' }) as never)).toBe('unknown');
    expect(socketIpBucket(socketWith({ 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '203.0.113.9' }) as never)).toBe('203.0.113.9');
    expect(socketIpBucket(socketWith({ 'x-real-ip': '::ffff:203.0.113.9' }) as never)).toBe('203.0.113.9');
    expect(socketIpBucket(socketWith({ 'x-real-ip': '2001:db8:1:2:aaaa::1' }) as never)).toBe('2001:0db8:0001:0002');
    expect(socketIpBucket(socketWith({ 'x-real-ip': '1.2.3.4, 5.6.7.8' }) as never)).toBe('unknown');
    env.NODE_ENV = original;
  });
});
