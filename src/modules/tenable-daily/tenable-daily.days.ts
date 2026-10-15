import { createDailyCalendar } from '../daily/daily.calendar.js';

/**
 * Football Tenable release calendar (Buenos Aires days, like every daily). Mirrors the web calendar exactly, and the
 * seeded days: 116 lists from the first archive day; boards are ranked from the launch day.
 */
export const CONTENT_START = '2026-10-12';
export const RANKED_START = '2026-10-17';
export const PUBLISHED_DAYS = 116;

export const tenableCalendar = createDailyCalendar({ contentStart: CONTENT_START, rankedStart: RANKED_START, publishedDays: PUBLISHED_DAYS });
