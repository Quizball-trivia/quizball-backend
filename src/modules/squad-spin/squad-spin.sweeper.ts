import { squadSpinService } from './squad-spin.service.js';
import { logger } from '../../core/logger.js';

/** Settles runs whose spin or decision deadline passed while the client was away. SKIP LOCKED keeps replicas and live players from fighting. */
const SWEEP_INTERVAL_MS = 15_000;
let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export function startSquadSpinSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void squadSpinService.sweepExpiredRounds()
      .then(({ settled }) => { if (settled > 0) logger.info({ settled }, 'squad-spin sweep settled expired rounds'); })
      .catch((error) => logger.error({ error }, 'squad-spin sweep failed'))
      .finally(() => { inFlight = false; });
  }, SWEEP_INTERVAL_MS);
}

export function stopSquadSpinSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
