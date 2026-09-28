/** Mirrors the web release calendar (frontend buscaminas.logic.ts) exactly. */
export const RELEASE_TIME_ZONE = 'America/Argentina/Buenos_Aires';
export const LAUNCH_DAY = '2026-09-26';
export const PUBLISHED_DAYS = 90;

const DAY_MS = 86_400_000;
const releaseFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: RELEASE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const wallClockFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: RELEASE_TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function releaseDay(now: Date = new Date()): string {
  const parts = releaseFormatter.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export const dayNumber = (day: string): number =>
  Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${LAUNCH_DAY}T00:00:00Z`)) / DAY_MS) + 1;

export function addDays(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Before launch → the first puzzle; after the last → the last (never a silent re-run). */
export function puzzleDayFor(today: string): string {
  const n = dayNumber(today);
  if (n < 1) return LAUNCH_DAY;
  if (n > PUBLISHED_DAYS) return addDays(LAUNCH_DAY, PUBLISHED_DAYS - 1);
  return today;
}

export const LAST_DAY = addDays(LAUNCH_DAY, PUBLISHED_DAYS - 1);

/** Today's release day while it is a published day; null before launch (the launch puzzle is an unranked preview) and after the last. */
export function rankedDay(now: Date = new Date()): string | null {
  const today = releaseDay(now);
  return today >= LAUNCH_DAY && today <= LAST_DAY ? today : null;
}

/** Default leaderboard day: the ranked day, else the launch day before launch and the final day after the run of puzzles. */
export const boardDay = (now: Date = new Date()): string => rankedDay(now) ?? puzzleDayFor(releaseDay(now));

export function isPlayableDay(day: string, now: Date = new Date()): boolean {
  return dayNumber(day) >= 1 && day <= puzzleDayFor(releaseDay(now));
}

/** A day already over in Buenos Aires; its answers can no longer help anyone rank. */
export const isArchiveDay = (day: string, now: Date = new Date()): boolean => day < releaseDay(now);

/** Buenos Aires wall-clock time minus UTC at `ms`. */
function zoneOffsetMs(ms: number): number {
  const parts = wallClockFormatter.formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(ms / 1000) * 1000;
}

/** The instant `day` ends in Buenos Aires (its next local midnight): the ranked cutoff for that day. */
export function dayEndsAt(day: string): Date {
  const wallMidnight = Date.parse(`${addDays(day, 1)}T00:00:00Z`);
  const guess = wallMidnight - zoneOffsetMs(wallMidnight);
  return new Date(wallMidnight - zoneOffsetMs(guess));
}
