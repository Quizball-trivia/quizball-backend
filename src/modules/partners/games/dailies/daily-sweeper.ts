/** Settles abandoned partner daily plays on every replica (SKIP LOCKED: replicas never settle the same play). */

import { logger } from '../../../../core/logger.js';
import { sweepAbandonedDailyPlays } from './daily-play.service.js';

const INTERVAL_MS = 15_000;
let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;

export function startPartnerDailiesSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = sweepAbandonedDailyPlays()
      .then((settled) => {
        if (settled > 0) logger.info({ settled }, 'partner dailies sweeper settled abandoned plays');
      })
      .catch((error) => logger.error({ error }, 'partner dailies sweeper failed'))
      .finally(() => {
        inFlight = null;
      });
  }, INTERVAL_MS);
  timer.unref();
}

export async function stopPartnerDailiesSweeper(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await inFlight;
}
