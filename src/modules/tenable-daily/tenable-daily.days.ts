import { createDailyCalendar } from '../daily/daily.calendar.js';

/**
 * Football Tenable release calendar (Buenos Aires days, like every daily). Mirrors the web calendar exactly, and the
 * seeded days: 116 lists from the first archive day; boards are ranked from the launch day.
 */
export const CONTENT_START = '2026-10-12';
export const RANKED_START = '2026-10-17';
/** Open-ended: a day exists once its row is seeded (like Darts 501 and Buscaminas). The HQ harness keeps days ahead of today. */
export const PUBLISHED_DAYS = 'open';

export const tenableCalendar = createDailyCalendar({ contentStart: CONTENT_START, rankedStart: RANKED_START, publishedDays: PUBLISHED_DAYS });
