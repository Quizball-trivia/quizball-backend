import { logger } from '../../../../core/logger.js';
import { partnerGuessTheGoalService } from './ggt-partner.service.js';

const SWEEP_INTERVAL_MS = 10_000;

let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;

/** Settles Freecroco Guess the Goal plays left at a deadline (every replica; settlement is row-locked and once-only). */
export function startPartnerGuessTheGoalSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = partnerGuessTheGoalService
      .sweepOverdue()
      .then((settled) => {
        if (settled > 0) logger.info({ settled }, 'partner guess-the-goal sweeper settled plays');
      })
      .catch((error) => logger.error({ err: error }, 'partner guess-the-goal sweeper failed'))
      .finally(() => {
        inFlight = null;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

export async function stopPartnerGuessTheGoalSweeper(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await inFlight;
}
