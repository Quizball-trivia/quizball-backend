import { describe, expect, it, vi } from 'vitest';

const resolve = vi.fn();
vi.mock('../../src/modules/guest/guest.service.js', () => ({
  GUEST_TOKEN_SHAPE: /^[a-f0-9]{64}$/,
  guestService: { resolve: (token: string) => resolve(token) },
}));

const { GuestAuthProvider, getGuestAuthProvider } = await import('../../src/modules/auth/guest-auth-provider.js');

describe('GuestAuthProvider', () => {
  it('handles only 64-hex tokens (Supabase JWTs go to the Supabase provider)', () => {
    expect(GuestAuthProvider.handles('a'.repeat(64))).toBe(true);
    expect(GuestAuthProvider.handles('eyJhbGciOiJIUzI1NiJ9.abc.def')).toBe(false);
    expect(GuestAuthProvider.handles('A'.repeat(64))).toBe(false);
  });

  it('maps a resolved session to a guest identity and propagates rejection', async () => {
    resolve.mockResolvedValueOnce({ id: 'g-1', locale: 'ka' });
    const identity = await getGuestAuthProvider().verifyToken('b'.repeat(64));
    expect(identity).toEqual({ provider: 'guest', subject: 'g-1', claims: { guestSessionId: 'g-1', locale: 'ka' } });
    resolve.mockRejectedValueOnce(new Error('Guest session expired'));
    await expect(getGuestAuthProvider().verifyToken('c'.repeat(64))).rejects.toThrow('Guest session expired');
  });
});
