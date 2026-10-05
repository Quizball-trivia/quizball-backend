/**
 * The release calendar. It has no fixed length: the stored days are the calendar, so content appended to the days
 * table opens on its own date with no release. The web reads the same days from /boards.
 */
export const RELEASE_TIME_ZONE = 'America/Argentina/Buenos_Aires';
export const LAUNCH_DAY = '2026-09-26';

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

/**
 * The last day of the unbroken run of stored days that starts at `first`; null when `first` itself has no content.
 * A calendar ends at its first hole: a day stored beyond a missing one is not released, so a failed append can
 * never leave a gap players fall into.
 */
export function lastReleasedDay(days: Iterable<string>, first: string): string | null {
  const stored = new Set(days);
  if (!stored.has(first)) return null;
  let last = first;
  for (let next = addDays(last, 1); stored.has(next); next = addDays(next, 1)) last = next;
  return last;
}

/**
 * A seed may add days anywhere, as long as the stored days and the new ones together still run unbroken from
 * `first`: no hole inside, and nothing before the first day. Names days only.
 */
export function assertUnbrokenCalendar(first: string, stored: Iterable<string>, incoming: Iterable<string>): void {
  const all = [...new Set([...stored, ...incoming])].sort();
  if (all.length === 0) throw new Error('no days to seed');
  if (all[0] !== first) throw new Error(`the calendar must start at ${first}; the earliest day is ${all[0]}`);
  all.forEach((day, i) => {
    const expected = addDays(first, i);
    if (day !== expected) throw new Error(`days must be contiguous from ${first}: ${expected} is missing (next stored or supplied day is ${day})`);
  });
}

/** An append adds only days the calendar does not have yet (with assertUnbrokenCalendar: right after the last one). */
export function assertAppendOnly(stored: Iterable<string>, incoming: Iterable<string>): void {
  const have = new Set(stored);
  const taken = [...incoming].filter((day) => have.has(day)).sort();
  if (taken.length > 0) throw new Error(`append only: already stored: ${taken.join(', ')}`);
}

/** A stored day inside the calendar (not beyond a hole). Runs of any other day are neither moved nor shown. */
export const isReleasedDay = (day: string, lastDay: string | null): boolean => lastDay !== null && day <= lastDay;

/**
 * How long a board index may be cached: `cap` seconds, but never past the next Buenos Aires midnight, when the
 * index gains a day. The web reads the calendar from it, so a copy cached before midnight must not outlive it.
 */
export function boardsMaxAge(now: Date = new Date(), cap = 300): number {
  const untilMidnight = Math.floor((dayEndsAt(releaseDay(now)).getTime() - now.getTime()) / 1000);
  return Math.max(0, Math.min(cap, untilMidnight));
}

/** Before launch → the first puzzle; after the last released day → that day (never a silent re-run). */
export function puzzleDayFor(today: string, lastDay: string | null): string {
  if (dayNumber(today) < 1) return LAUNCH_DAY;
  // No content at all: today's (empty) puzzle, as before any day is seeded.
  return lastDay !== null && today > lastDay ? lastDay : today;
}

/** Today's release day while it has content; null before launch (the launch puzzle is an unranked preview) and after the last released day. */
export function rankedDay(lastDay: string | null, now: Date = new Date()): string | null {
  const today = releaseDay(now);
  return lastDay !== null && today >= LAUNCH_DAY && today <= lastDay ? today : null;
}

/** Default leaderboard day: the ranked day, else the launch day before launch and the last released day after the run of puzzles. */
export const boardDay = (lastDay: string | null, now: Date = new Date()): string => rankedDay(lastDay, now) ?? puzzleDayFor(releaseDay(now), lastDay);

export function isPlayableDay(day: string, lastDay: string | null, now: Date = new Date()): boolean {
  return lastDay !== null && dayNumber(day) >= 1 && day <= puzzleDayFor(releaseDay(now), lastDay);
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
