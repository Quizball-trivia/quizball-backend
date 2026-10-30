import { logger } from '../../../../core/logger.js';
import { partnerFakeFactService } from './fake-fact.service.js';

const SWEEP_INTERVAL_MS = 10_000;

let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;

/** Settles Freecroco Fake Fact plays left at a deadline (every replica; settlement is row-locked and once-only). */
export function startPartnerFakeFactSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = partnerFakeFactService
      .sweepOverdue()
      .then((settled) => {
        if (settled > 0) logger.info({ settled }, 'partner fake-fact sweeper settled plays');
      })
      .catch((error) => logger.error({ err: error }, 'partner fake-fact sweeper failed'))
      .finally(() => {
        inFlight = null;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

export async function stopPartnerFakeFactSweeper(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await inFlight;
}
