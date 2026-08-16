import { freeKicksService } from './free-kicks.service.js';
import { logger } from '../../core/logger.js';

/**
 * Interval worker that auto-settles abandoned rounds (post-goal pots cash out,
 * mid-attack abandons expire). Safe with multiple replicas: the service claims
 * rounds FOR UPDATE SKIP LOCKED, so concurrent sweeps and live player actions
 * never fight.
 *
 * Runs regardless of FREE_KICKS_ENABLED — the kill switch blocks only new
 * rounds; existing liabilities must always settle.
 */

const SWEEP_INTERVAL_MS = 15_000;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export function startFreeKicksSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void freeKicksService
      .sweepStaleRounds()
      .then(({ settled }) => {
        if (settled > 0) logger.info({ settled }, 'free-kicks sweeper settled stale rounds');
      })
      .catch((error) => {
        logger.error({ error }, 'free-kicks sweeper tick failed');
      })
      .finally(() => {
        inFlight = false;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopFreeKicksSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
