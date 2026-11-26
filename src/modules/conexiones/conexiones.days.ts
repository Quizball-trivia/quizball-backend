import { createDailyCalendar } from '../daily/daily.calendar.js';

/** Conexiones futboleras daily calendar: the daily-game calendar (Buenos Aires days). Mirrors the web calendar exactly. */
/** Board set #1 (staging: three closed days for guests before the first ranked one). Re-date with the seed before the production release. */
export const CONTENT_START = '2026-10-21';
/** The first ranked day; earlier days are unranked practice (guests' first closed days). */
export const RANKED_START = '2026-10-24';
/** Days with content, counted from CONTENT_START. */
/** Open-ended: a day exists once its row is seeded (like Darts 501 and Buscaminas). The HQ harness keeps days ahead of today. */
export const PUBLISHED_DAYS = 'open';

export const conexionesCalendar = createDailyCalendar({ contentStart: CONTENT_START, rankedStart: RANKED_START, publishedDays: PUBLISHED_DAYS });
