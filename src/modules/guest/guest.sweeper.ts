import { guestRepo } from './guest.repo.js';
import { GUEST_PURGE_DAYS } from './guest.service.js';
import { logger } from '../../core/logger.js';

/** Once a day: drop guest identities idle for GUEST_PURGE_DAYS (their completions cascade). */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

export function startGuestSweeper(): void {
  if (timer) return;
  const run = () => guestRepo.purgeIdle(GUEST_PURGE_DAYS).then((n) => { if (n > 0) logger.info({ purged: n }, 'guest sweep removed idle sessions'); }).catch((error) => logger.error({ error }, 'guest sweep failed'));
  timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
  setTimeout(run, 60_000).unref();
}

export function stopGuestSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
