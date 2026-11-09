import { createDailyCalendar } from '../daily/daily.calendar.js';

/**
 * Football Draft release calendar (Buenos Aires days, like every daily). Mirrors the web calendar exactly, and the seeded
 * days: the first days are closed practice days for guests; boards are ranked from the launch day.
 */
export const CONTENT_START = '2026-10-31';
export const RANKED_START = '2026-11-05';
export const PUBLISHED_DAYS = 400;

export const draftCalendar = createDailyCalendar({ contentStart: CONTENT_START, rankedStart: RANKED_START, publishedDays: PUBLISHED_DAYS });
