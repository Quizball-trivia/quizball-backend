import { createDailyCalendar } from '../daily/daily.calendar.js';

/**
 * Football Darts 501 release calendar (Buenos Aires days, like every daily). Mirrors the web calendar exactly, and the
 * seeded days: the first five are closed practice days for guests; boards are ranked from the launch day.
 */
export const CONTENT_START = '2026-10-24';
export const RANKED_START = '2026-10-27';
export const PUBLISHED_DAYS = 95;

export const darts501Calendar = createDailyCalendar({ contentStart: CONTENT_START, rankedStart: RANKED_START, publishedDays: PUBLISHED_DAYS });
