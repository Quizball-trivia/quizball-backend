import { createHash, randomBytes } from 'crypto';
import { AuthenticationError } from '../../core/errors.js';
import { guestRepo, type GuestSessionRow } from './guest.repo.js';

/**
 * Guest identity for public play. The token is opaque (32 random bytes, hex);
 * only its SHA-256 is stored, so a database read cannot impersonate a guest.
 * A guest can play today's real daily sets and nothing else: no wallet, XP,
 * streak, leaderboard row or competitive entry is ever created for it.
 */
export const GUEST_TOKEN_HEADER = 'x-guest-token';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const hashSignal = (value: string | null | undefined) => (value ? createHash('sha256').update(value).digest('hex').slice(0, 32) : null);

export const guestService = {
  async createSession(input: { locale: string | null; ip: string | null; deviceId: string | null }): Promise<{ token: string; guestId: string }> {
    const token = randomBytes(32).toString('hex');
    const row = await guestRepo.insert({ tokenHash: hashToken(token), locale: input.locale, ipHash: hashSignal(input.ip), deviceHash: hashSignal(input.deviceId) });
    return { token, guestId: row.id };
  },

  async resolve(token: string | null | undefined): Promise<GuestSessionRow> {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new AuthenticationError('Missing guest token');
    const row = await guestRepo.findByTokenHash(hashToken(token));
    if (!row) throw new AuthenticationError('Unknown guest token');
    void guestRepo.touch(row.id).catch(() => undefined);
    return row;
  },
};
