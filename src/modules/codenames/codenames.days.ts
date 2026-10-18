import { addDays, createDailyCalendar, dayEndsAt, releaseDay, RELEASE_TIME_ZONE } from '../daily/daily.calendar.js';

/** Football Codenames daily calendar: the daily-game calendar (Buenos Aires days). Mirrors the web calendar exactly. */
export { addDays, dayEndsAt, releaseDay, RELEASE_TIME_ZONE };

/** Board #1: the launch day (staging, 2026-10-19). Re-date with the seed before the production release. */
export const CONTENT_START = '2026-10-19';
/** The first ranked day: the launch day itself. */
export const RANKED_START = '2026-10-19';
/** Days with content, counted from CONTENT_START (to 2026-12-25). */
export const PUBLISHED_DAYS = 68;

export const codenamesCalendar = createDailyCalendar({ contentStart: CONTENT_START, rankedStart: RANKED_START, publishedDays: PUBLISHED_DAYS });
export const { LAST_DAY, dayNumber, isPlayableDay, rankedDay, isClosedDay, boardDay } = codenamesCalendar;
