import { addDays, releaseDay } from '../buscaminas/buscaminas.days.js';

export { addDays, dayEndsAt, releaseDay, RELEASE_TIME_ZONE } from '../buscaminas/buscaminas.days.js';

const DAY_MS = 86_400_000;

/**
 * A daily game's release calendar: Buenos Aires days (like Buscaminas), no future or preview days, a day
 * playable from its own midnight. `rankedStart` is the public launch; earlier days are practice for everyone.
 * Each game's web calendar mirrors its constants exactly.
 */
export function createDailyCalendar(config: { contentStart: string; rankedStart: string; publishedDays: number }) {
  const { contentStart, rankedStart } = config;
  const lastDay = addDays(contentStart, config.publishedDays - 1);

  function rankedDay(now: Date = new Date()): string | null {
    const today = releaseDay(now);
    return today >= rankedStart && today <= lastDay ? today : null;
  }

  return {
    LAST_DAY: lastDay,
    /** 1 for the first content day. */
    dayNumber: (day: string): number => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${contentStart}T00:00:00Z`)) / DAY_MS) + 1,
    /** contentStart <= day <= min(today, lastDay): never a future day. */
    isPlayableDay(day: string, now: Date = new Date()): boolean {
      const today = releaseDay(now);
      return day >= contentStart && day <= today && day <= lastDay;
    },
    /** Today while it is a ranked day; otherwise nothing is ranked. */
    rankedDay,
    /** Already over in Buenos Aires by this clock (the app's); answers gate on the database clock instead. */
    isClosedDay: (day: string, now: Date = new Date()): boolean => day < releaseDay(now),
    /** Default leaderboard day: the ranked day, else the launch day before launch and the last day after the run. */
    boardDay(now: Date = new Date()): string {
      const ranked = rankedDay(now);
      if (ranked) return ranked;
      return releaseDay(now) < rankedStart ? rankedStart : lastDay;
    },
  };
}

export type DailyCalendar = ReturnType<typeof createDailyCalendar>;
