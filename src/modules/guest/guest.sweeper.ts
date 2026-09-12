import { guestRepo } from './guest.repo.js';
import { GUEST_PURGE_DAYS } from './guest.service.js';
import { GUEST_IDENTITY_PROVIDER } from './guest-identity.js';
import { identitiesRepo } from '../users/identities.repo.js';
import { usersRepo } from '../users/users.repo.js';
import { invalidateUser } from '../users/user-cache.js';
import { disconnectUserSockets } from '../../realtime/services/auth-realtime.service.js';
import { logger } from '../../core/logger.js';

/**
 * Once a day: retire guest sessions idle for GUEST_PURGE_DAYS. A session that
 * played friend rooms owns a users row; that row is TOMBSTONED (identifying
 * fields cleared, is_guest kept) — never deleted, because grid claims, series
 * winners and lobby hosts reference it with RESTRICT and members keep their
 * shared history. The identity mapping is revoked in the same pass, the user
 * cache invalidated and any live socket disconnected, so a stored token stops
 * working everywhere at once. Daily-only guests (no users row) are just deleted.
 */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

export async function sweepIdleGuests(days = GUEST_PURGE_DAYS): Promise<{ sessions: number; tombstoned: number }> {
  const ids = await guestRepo.listIdleIds(days);
  let tombstoned = 0;
  for (const sessionId of ids) {
    try {
      const userId = await identitiesRepo.deleteByProviderSubject(GUEST_IDENTITY_PROVIDER, sessionId);
      if (userId) {
        await usersRepo.tombstoneGuest(userId);
        await invalidateUser(GUEST_IDENTITY_PROVIDER, sessionId, userId).catch(() => undefined);
        await disconnectUserSockets(userId, 'guest_expired').catch(() => undefined);
        tombstoned += 1;
      }
    } catch (error) {
      logger.warn({ error, sessionId }, 'guest sweep: tombstone failed, session kept for the next pass');
      continue;
    }
    await guestRepo.deleteByIds([sessionId]);
  }
  return { sessions: ids.length, tombstoned };
}

export function startGuestSweeper(): void {
  if (timer) return;
  const run = () => sweepIdleGuests().then((n) => { if (n.sessions > 0) logger.info(n, 'guest sweep retired idle sessions'); }).catch((error) => logger.error({ error }, 'guest sweep failed'));
  timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
  setTimeout(run, 60_000).unref();
}

export function stopGuestSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
