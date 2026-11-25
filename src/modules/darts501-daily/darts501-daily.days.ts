import { createDailyCalendar } from '../daily/daily.calendar.js';

/**
 * Football Darts 501 release calendar (Buenos Aires days, like every daily). Open-ended: a day exists once its row is
 * seeded in darts501_days, so new boards need no release. The first days are closed practice days for guests; boards
 * are ranked from the launch day.
 */
export const CONTENT_START = '2026-10-24';
export const RANKED_START = '2026-10-27';
export const PUBLISHED_DAYS = 'open';

export const darts501Calendar = createDailyCalendar({ contentStart: CONTENT_START, rankedStart: RANKED_START, publishedDays: PUBLISHED_DAYS });
