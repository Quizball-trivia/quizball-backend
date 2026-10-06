/** Ends every started Freecroco Road to Goal and Trivia Mines play whose player never came back (contract §6–7):
 *  expired question/decision deadlines and silent Mines boards. SKIP LOCKED keeps replicas and live players apart. */

import { logger } from '../../../../core/logger.js';
import { partnerTriviaMinesService } from '../trivia-mines/partner-trivia-mines.service.js';
import { partnerRoadToGoalService } from './partner-road-to-goal.service.js';

const SWEEP_INTERVAL_MS = 15_000;
let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;

async function sweepOnce(): Promise<void> {
  for (const [game, sweep] of [
    ['road-to-goal', () => partnerRoadToGoalService.sweep()],
    ['trivia-mines', () => partnerTriviaMinesService.sweep()],
  ] as const) {
    try {
      const { settled } = await sweep();
      if (settled > 0) logger.info({ game, settled }, 'partner sweeper settled abandoned runs');
    } catch (error) {
      logger.error({ error, game }, 'partner sweeper failed');
    }
  }
}

export function startPartnerRtgMinesSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = sweepOnce().finally(() => { inFlight = null; });
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

export async function stopPartnerRtgMinesSweeper(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await inFlight;
}
