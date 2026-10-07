import { logger } from '../../../../core/logger.js';
import { partnerCardDetectiveService } from './cd-partner.service.js';

const SWEEP_INTERVAL_MS = 30_000;

let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;

/** Settles Freecroco Card Detective plays left idle (every replica; settlement is row-locked and once-only). */
export function startPartnerCardDetectiveSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = partnerCardDetectiveService
      .sweepIdle()
      .then((settled) => {
        if (settled > 0) logger.info({ settled }, 'partner card-detective sweeper settled idle plays');
      })
      .catch((error) => logger.error({ err: error }, 'partner card-detective sweeper failed'))
      .finally(() => {
        inFlight = null;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

export async function stopPartnerCardDetectiveSweeper(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await inFlight;
}
