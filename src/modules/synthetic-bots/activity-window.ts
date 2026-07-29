/**
 * Shared activity-window predicate for roster bots.
 *
 * Extracted from `synthetic-bot-selection.service.ts` so the social workers
 * (rename, and any future bot-visible action) apply EXACTLY the same window as
 * match selection. Two copies of the past-midnight wrap logic would eventually
 * disagree, and a bot renaming at 04:00 while never playing then is precisely
 * the kind of inconsistency that reads as automation.
 */

/** The per-bot schedule shape stored in `synthetic_player_profiles.schedule`. */
interface ScheduleShape {
  startHour?: unknown;
  endHour?: unknown;
}

/**
 * Is `now` inside the bot's active-hour window (Asia/Tbilisi)?
 *
 * A missing or malformed schedule returns true: the schedule is the LAST soft
 * constraint relaxed during selection, so a bad one must never hard-exclude.
 */
export function isWithinScheduleWindow(schedule: unknown, now = new Date()): boolean {
  const parsed = schedule as ScheduleShape | null;
  const start = typeof parsed?.startHour === 'number' ? parsed.startHour : null;
  const endRaw = typeof parsed?.endHour === 'number' ? parsed.endHour : null;
  if (start === null || endRaw === null) return true;

  const hourStr = now.toLocaleString('en-US', {
    timeZone: 'Asia/Tbilisi',
    hour: '2-digit',
    hour12: false,
  });
  const hour = Number.parseInt(hourStr, 10) % 24;

  // Generated evening schedules encode past-midnight windows as endHour > 24
  // (e.g. 17→25 means 17:00–00:59). Treat any endHour ≥ 24 as wrapping, and
  // normalize to [0,24) for the comparison so 00:00–00:59 is correctly INCLUDED.
  const end = ((endRaw % 24) + 24) % 24;
  const startNorm = ((start % 24) + 24) % 24;
  if (startNorm === end) return true;
  return startNorm < end ? hour >= startNorm && hour < end : hour >= startNorm || hour < end;
}
