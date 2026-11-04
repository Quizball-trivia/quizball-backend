import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { audienceRepo } from './audience.repo.js';
import { addDays, georgiaToday } from './audience.service.js';

/** The earliest day the play tables are complete enough to count (see reference_game_usage_audit_2026_10_25). */
export const COVERAGE_START = '2026-02-05';
const INTERVAL_MS = 10 * 60_000;
const BACKFILL_DAYS_PER_TICK = 3;
let timer: ReturnType<typeof setInterval> | undefined;
let running: Promise<void> | undefined;

/** Refresh yesterday and today, then fill a few never-refreshed days (newest first) until COVERAGE_START. */
export async function runAudienceRefresh(now = new Date()): Promise<void> {
  const today = georgiaToday(now);
  const yesterday = addDays(today, -1);
  for (const day of [yesterday, today]) {
    if ((await audienceRepo.refreshDays(day, day, false)) === -1) return;
  }
  for (const day of await audienceRepo.missingDays(COVERAGE_START, addDays(yesterday, -1), BACKFILL_DAYS_PER_TICK)) {
    if ((await audienceRepo.refreshDays(day, day, false)) === -1) return;
  }
}

function tick(): void {
  if (running) return;
  running = runAudienceRefresh()
    .catch((err) => logger.warn({ err }, 'Audience refresh failed'))
    .finally(() => { running = undefined; });
}

export function startAudienceWorker(): void {
  if (timer || (config.NODE_ENV !== 'prod' && config.NODE_ENV !== 'staging')) return;
  setTimeout(tick, 60_000).unref();
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref();
}

export async function stopAudienceWorker(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  await running;
}
