import { addDays, createDailyCalendar, dayEndsAt, releaseDay, RELEASE_TIME_ZONE } from '../daily/daily.calendar.js';

/** Último en pie release calendar: the daily-game calendar (Buenos Aires days). Mirrors the web calendar exactly. */
export { addDays, dayEndsAt, releaseDay, RELEASE_TIME_ZONE };

/** The first playable (archive) day. */
export const CONTENT_START = '2026-09-28';
/** The first ranked day (the public launch); earlier days are unranked practice for everyone. */
export const RANKED_START = '2026-09-30';
/** Days with content, counted from CONTENT_START. */
export const PUBLISHED_DAYS = 30;

export const ultimoCalendar = createDailyCalendar({ contentStart: CONTENT_START, rankedStart: RANKED_START, publishedDays: PUBLISHED_DAYS });
export const { LAST_DAY, dayNumber, isPlayableDay, rankedDay, isClosedDay, boardDay } = ultimoCalendar;
