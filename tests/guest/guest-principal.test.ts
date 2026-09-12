import { beforeEach, describe, expect, it, vi } from 'vitest';

const getOrCreateGuest = vi.fn();
vi.mock('../../src/modules/users/users.service.js', () => ({ usersService: { getOrCreateGuest } }));
vi.mock('../../src/modules/guest/guest.service.js', () => ({ guestService: {}, GUEST_TOKEN_HEADER: 'x-guest-token', GUEST_TOKEN_SHAPE: /^[a-f0-9]{64}$/ }));
vi.mock('../../src/modules/daily-challenges/daily-challenges.service.js', () => ({ dailyChallengesService: {} }));
vi.mock('../../src/http/client-ip.js', () => ({ resolveTrustedClientIp: () => '1.2.3.4' }));

const { config } = await import('../../src/core/config.js');
const flags = config as unknown as { GUEST_LOBBIES_PROVISIONING_ENABLED: boolean; GUEST_LOBBIES_RECONNECT_ENABLED: boolean };
const { guestController } = await import('../../src/modules/guest/guest.controller.js');

function call() {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const req = { guest: { id: 'g-1', locale: 'en', linkedUserId: null }, headers: {}, validated: {} };
  return guestController.principal(req as never, res as never).then(() => res);
}

describe('POST /guest/principal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.GUEST_LOBBIES_PROVISIONING_ENABLED = false;
    flags.GUEST_LOBBIES_RECONNECT_ENABLED = false;
  });

  it('is closed while both flags are off', async () => {
    await expect(call()).rejects.toThrow('Guest play is not available');
    expect(getOrCreateGuest).not.toHaveBeenCalled();
  });

  it('returns the provisioned users row with the guest marker (201 on first provision, 200 after)', async () => {
    flags.GUEST_LOBBIES_PROVISIONING_ENABLED = true;
    flags.GUEST_LOBBIES_RECONNECT_ENABLED = true;
    getOrCreateGuest.mockResolvedValueOnce({ user: { id: 'u-1', nickname: 'Mystery Keeper 4821', avatar_customization: { jersey: 'jersey_green' } }, created: true });
    const res = await call();
    expect(getOrCreateGuest).toHaveBeenCalledWith({ provider: 'guest', subject: 'g-1', claims: {} }, null, { allowCreate: true });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ user_id: 'u-1', nickname: 'Mystery Keeper 4821', avatar_customization: { jersey: 'jersey_green' }, is_guest: true });
    getOrCreateGuest.mockResolvedValueOnce({ user: { id: 'u-1', nickname: 'Mystery Keeper 4821', avatar_customization: null }, created: false });
    expect((await call()).status).toHaveBeenCalledWith(200);
  });

  it('refuses a returning guest while reconnect is off (drain)', async () => {
    flags.GUEST_LOBBIES_PROVISIONING_ENABLED = true;
    getOrCreateGuest.mockResolvedValueOnce({ user: { id: 'u-1', nickname: 'x', avatar_customization: null }, created: false });
    await expect(call()).rejects.toThrow('Guest play is not available');
  });
});
