import { lastReleasedDay, releaseDay } from '../buscaminas/buscaminas.days.js';

export { addDays, assertAppendOnly, assertUnbrokenCalendar, boardsMaxAge, dayEndsAt, isReleasedDay, lastReleasedDay, releaseDay, RELEASE_TIME_ZONE } from '../buscaminas/buscaminas.days.js';

const DAY_MS = 86_400_000;

/**
 * A daily game's release calendar: Buenos Aires days (like Buscaminas), no future or preview days, a day
 * playable from its own midnight. `rankedStart` is the public launch; earlier days are practice for everyone.
 * The calendar has no fixed length: its last day is the last stored day of the unbroken run from `contentStart`
 * (`lastDay`), which callers pass in from the content they serve. The web reads the same days from /boards.
 */
export function createDailyCalendar(config: { contentStart: string; rankedStart: string }) {
  const { contentStart, rankedStart } = config;

  function rankedDay(lastDay: string | null, now: Date = new Date()): string | null {
    const today = releaseDay(now);
    return lastDay !== null && today >= rankedStart && today <= lastDay ? today : null;
  }

  return {
    /** The last released day among the stored days; null while the first content day has no content. */
    lastDay: (days: Iterable<string>): string | null => lastReleasedDay(days, contentStart),
    /** 1 for the first content day. */
    dayNumber: (day: string): number => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${contentStart}T00:00:00Z`)) / DAY_MS) + 1,
    /** contentStart <= day <= min(today, lastDay): never a future day, never a day past a hole. */
    isPlayableDay(day: string, lastDay: string | null, now: Date = new Date()): boolean {
      const today = releaseDay(now);
      return lastDay !== null && day >= contentStart && day <= today && day <= lastDay;
    },
    /** Today while it is a ranked day; otherwise nothing is ranked. */
    rankedDay,
    /** Already over in Buenos Aires by this clock (the app's); answers gate on the database clock instead. */
    isClosedDay: (day: string, now: Date = new Date()): boolean => day < releaseDay(now),
    /** Default leaderboard day: the ranked day, else the launch day before launch and the last released day after the run. */
    boardDay(lastDay: string | null, now: Date = new Date()): string {
      const ranked = rankedDay(lastDay, now);
      if (ranked) return ranked;
      const today = releaseDay(now);
      if (today < rankedStart) return rankedStart;
      // No content at all: today's (empty) board, as before any day is seeded.
      return lastDay ?? today;
    },
  };
}

export type DailyCalendar = ReturnType<typeof createDailyCalendar>;
