/** Partner housekeeping on every replica (the update is idempotent, so replicas never conflict). */

import { logger } from '../../core/logger.js';
import { forgetExpiredInitResponses } from './partner-sessions.service.js';

const INTERVAL_MS = 10 * 60_000;
let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;

export function startPartnerJanitor(): void {
  if (timer) return;
  const run = () => {
    if (inFlight) return;
    inFlight = forgetExpiredInitResponses()
      .then((n) => {
        if (n > 0) logger.info({ expired: n }, 'partner janitor expired unopened launches');
      })
      .catch((error) => logger.error({ err: error }, 'partner janitor failed'))
      .finally(() => {
        inFlight = null;
      });
  };
  timer = setInterval(run, INTERVAL_MS);
  timer.unref();
}

export async function stopPartnerJanitor(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await inFlight;
}
