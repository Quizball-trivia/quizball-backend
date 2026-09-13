import { guestRepo } from './guest.repo.js';
import { GUEST_PURGE_DAYS } from './guest.service.js';
import { GUEST_IDENTITY_PROVIDER } from './guest-identity.js';
import { invalidateUser } from '../users/user-cache.js';
import { disconnectUserSockets } from '../../realtime/services/auth-realtime.service.js';
import { logger } from '../../core/logger.js';

/**
 * Once a day: retire guest sessions idle for GUEST_PURGE_DAYS. A session that
 * played friend rooms owns a users row; that row is TOMBSTONED (identifying
 * fields cleared, is_guest kept) — never deleted, because grid claims, series
 * winners and lobby hosts reference it with RESTRICT and members keep their
 * shared history. Tombstone, identity revocation and session delete commit
 * together (guestRepo.retireSession), so a partial failure leaves the session
 * for the next pass instead of orphaning an identifiable row. Cache eviction
 * and socket disconnect run after commit; a stored token is already dead by
 * then (no identity), so those are best-effort. Daily-only guests (no users
 * row) are just deleted.
 */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 500;
const SWEEP_MAX_BATCHES = 200;
let timer: NodeJS.Timeout | null = null;

export async function sweepIdleGuests(days = GUEST_PURGE_DAYS): Promise<{ sessions: number; tombstoned: number }> {
  let sessions = 0;
  let tombstoned = 0;
  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch += 1) {
    const ids = await guestRepo.listIdleIds(days, SWEEP_BATCH);
    if (ids.length === 0) break;
    let failed = 0;
    for (const sessionId of ids) {
      let userId: string | null;
      try {
        ({ userId } = await guestRepo.retireSession(sessionId, GUEST_IDENTITY_PROVIDER));
      } catch (error) {
        failed += 1;
        logger.warn({ error, sessionId }, 'guest sweep: retire failed, session kept for the next pass');
        continue;
      }
      sessions += 1;
      if (userId) {
        tombstoned += 1;
        await invalidateUser(GUEST_IDENTITY_PROVIDER, sessionId, userId).catch(() => undefined);
        await disconnectUserSockets(userId, 'guest_expired').catch(() => undefined);
      }
    }
    // A batch that fails entirely would be re-selected forever; stop and retry tomorrow.
    if (failed === ids.length || ids.length < SWEEP_BATCH) break;
  }
  return { sessions, tombstoned };
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
