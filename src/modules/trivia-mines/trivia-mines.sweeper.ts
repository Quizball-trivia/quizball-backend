import { triviaMinesService } from './trivia-mines.service.js';
import { logger } from '../../core/logger.js';

/** Auto-settles abandoned rounds (banks pots with picks, refunds untouched boards). SKIP LOCKED keeps replicas and live players from fighting. */
const SWEEP_INTERVAL_MS = 15_000;
let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export function startTriviaMinesSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void triviaMinesService.sweepStaleRounds()
      .then(({ settled }) => { if (settled > 0) logger.info({ settled }, 'trivia-mines sweep settled stale rounds'); })
      .catch((error) => logger.error({ error }, 'trivia-mines sweep failed'))
      .finally(() => { inFlight = false; });
  }, SWEEP_INTERVAL_MS);
}

export function stopTriviaMinesSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
