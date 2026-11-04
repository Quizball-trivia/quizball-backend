import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { audienceRepo } from './audience.repo.js';
import { COVERAGE_START, addDays, georgiaToday } from './audience.service.js';

const INTERVAL_MS = 10 * 60_000;
const BACKFILL_DAYS_PER_TICK = 6;
let timer: ReturnType<typeof setInterval> | undefined;
let firstTick: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
let running: Promise<void> | undefined;

/** Refresh today, then the newest days that are not final yet (yesterday until it is), back to COVERAGE_START. */
export async function runAudienceRefresh(now = new Date()): Promise<void> {
  const today = georgiaToday(now);
  if ((await audienceRepo.refreshDays(today, today, false)) === -1) return;
  for (const day of await audienceRepo.incompleteDays(COVERAGE_START, addDays(today, -1), BACKFILL_DAYS_PER_TICK)) {
    if ((await audienceRepo.refreshDays(day, day, false)) === -1) return;
  }
}

function tick(): void {
  if (running || stopped) return;
  running = runAudienceRefresh()
    .catch((err) => logger.warn({ err }, 'Audience refresh failed'))
    .finally(() => { running = undefined; });
}

export function startAudienceWorker(): void {
  if (timer || (config.NODE_ENV !== 'prod' && config.NODE_ENV !== 'staging')) return;
  stopped = false;
  firstTick = setTimeout(tick, 60_000);
  firstTick.unref();
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref();
}

export async function stopAudienceWorker(): Promise<void> {
  stopped = true;
  if (firstTick) clearTimeout(firstTick);
  if (timer) clearInterval(timer);
  firstTick = undefined;
  timer = undefined;
  await running;
}
