import { createHash, createHmac, randomBytes } from 'crypto';
import { config } from '../../core/config.js';
import { AuthenticationError } from '../../core/errors.js';
import { guestRepo, type GuestSessionRow } from './guest.repo.js';

/**
 * Guest identity for public play. The token is opaque (32 random bytes, hex);
 * only its SHA-256 is stored, so a database read cannot impersonate a guest.
 * A guest can play today's real daily sets and nothing else: no wallet, XP,
 * streak, leaderboard row or competitive entry is ever created for it.
 */
export const GUEST_TOKEN_HEADER = 'x-guest-token';
/** A token unused for this long stops working; the sweeper deletes it (and its completions) after GUEST_PURGE_DAYS. */
export const GUEST_IDLE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
export const GUEST_PURGE_DAYS = 45;
export const GUEST_TOKEN_SHAPE = /^[a-f0-9]{64}$/;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
// Keyed: a database reader cannot enumerate IPv4 addresses against ip_hash. Outside
// local the SMS hook secret is already mandatory, so a real key always exists.
const signalKey = () => config.GUEST_SIGNAL_HMAC_KEY ?? config.SUPABASE_SMS_HOOK_SECRET ?? config.SUPABASE_SECRET_KEY ?? 'guest-signal-local';
const hashSignal = (value: string | null | undefined) => (value ? createHmac('sha256', signalKey()).update(value).digest('hex').slice(0, 32) : null);

export const guestService = {
  async createSession(input: { locale: string | null; ip: string | null; deviceId: string | null }): Promise<{ token: string; guestId: string }> {
    const token = randomBytes(32).toString('hex');
    const row = await guestRepo.insert({ tokenHash: hashToken(token), locale: input.locale, ipHash: hashSignal(input.ip), deviceHash: hashSignal(input.deviceId) });
    return { token, guestId: row.id };
  },

  async resolve(token: string | null | undefined): Promise<GuestSessionRow> {
    if (!token || !GUEST_TOKEN_SHAPE.test(token)) throw new AuthenticationError('Missing guest token');
    const row = await guestRepo.findByTokenHash(hashToken(token));
    if (!row) throw new AuthenticationError('Unknown guest token');
    if (Date.now() - new Date(row.last_seen_at).getTime() > GUEST_IDLE_EXPIRY_MS) throw new AuthenticationError('Guest session expired');
    void guestRepo.touch(row.id).catch(() => undefined);
    return row;
  },
};
