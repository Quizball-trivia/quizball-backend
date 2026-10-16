import { addDays, createDailyCalendar, dayEndsAt, releaseDay, RELEASE_TIME_ZONE } from '../daily/daily.calendar.js';

/** Football Horserace daily calendar: the daily-game calendar (Buenos Aires days). Mirrors the web calendar exactly. */
export { addDays, dayEndsAt, releaseDay, RELEASE_TIME_ZONE };

/** Race #1: the launch day (owner's choice: no archive days before it, so guests get their first race the next day). */
export const CONTENT_START = '2026-10-17';
/** The first ranked day: the launch day itself. */
export const RANKED_START = '2026-10-17';
/** Days with content, counted from CONTENT_START (to 2026-12-31). */
export const PUBLISHED_DAYS = 76;

export const footballRaceCalendar = createDailyCalendar({ contentStart: CONTENT_START, rankedStart: RANKED_START, publishedDays: PUBLISHED_DAYS });
export const { LAST_DAY, dayNumber, isPlayableDay, rankedDay, isClosedDay, boardDay } = footballRaceCalendar;
