import { addDays, createDailyCalendar, dayEndsAt, releaseDay, RELEASE_TIME_ZONE } from '../daily/daily.calendar.js';

/** Último en pie release calendar: the daily-game calendar (Buenos Aires days). Mirrors the web calendar exactly. */
export { addDays, dayEndsAt, releaseDay, RELEASE_TIME_ZONE };

/** The first playable (archive) day. */
export const CONTENT_START = '2026-09-28';
/** The first ranked day (the public launch); earlier days are unranked practice for everyone. */
export const RANKED_START = '2026-09-30';
export const ultimoCalendar = createDailyCalendar({ contentStart: CONTENT_START, rankedStart: RANKED_START });
export const { lastDay, dayNumber, isPlayableDay, rankedDay, isClosedDay, boardDay } = ultimoCalendar;
