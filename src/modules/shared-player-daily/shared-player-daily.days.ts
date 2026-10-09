import { createDailyCalendar } from '../daily/daily.calendar.js';

/** "Played for both" release calendar: the daily-game calendar (Buenos Aires days). Mirrors the web calendar exactly. */
/** The first playable (archive) day. */
export const CONTENT_START = '2026-10-06';
/** The first ranked day (the public launch); earlier days are unranked practice for everyone. */
export const RANKED_START = '2026-10-08';
/** Days with content, counted from CONTENT_START. */
export const PUBLISHED_DAYS = 75;

export const sharedPlayerCalendar = createDailyCalendar({ contentStart: CONTENT_START, rankedStart: RANKED_START, publishedDays: PUBLISHED_DAYS });
