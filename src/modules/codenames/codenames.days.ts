import { addDays, createDailyCalendar, dayEndsAt, releaseDay, RELEASE_TIME_ZONE } from '../daily/daily.calendar.js';

/** Football Codenames daily calendar: the daily-game calendar (Buenos Aires days). Mirrors the web calendar exactly. */
export { addDays, dayEndsAt, releaseDay, RELEASE_TIME_ZONE };

/** Board #1: the launch day (2026-10-20; the production seed is dated from it). */
export const CONTENT_START = '2026-10-20';
/** The first ranked day: the launch day itself. */
export const RANKED_START = '2026-10-20';
/** Days with content, counted from CONTENT_START (to 2026-12-24). */
/** Open-ended: a day exists once its row is seeded (like Darts 501 and Buscaminas). The HQ harness keeps days ahead of today. */
export const PUBLISHED_DAYS = 'open';

export const codenamesCalendar = createDailyCalendar({ contentStart: CONTENT_START, rankedStart: RANKED_START, publishedDays: PUBLISHED_DAYS });
export const { LAST_DAY, dayNumber, isPlayableDay, rankedDay, isClosedDay, boardDay } = codenamesCalendar;
