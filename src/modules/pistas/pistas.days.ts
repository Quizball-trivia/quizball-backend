import { addDays, createDailyCalendar, dayEndsAt, releaseDay, RELEASE_TIME_ZONE } from '../daily/daily.calendar.js';

/**
 * Pistas futboleras release calendar (Buenos Aires days, like Buscaminas) with no future or preview
 * days: a day becomes playable at its own midnight. Mirrors the web calendar exactly.
 */
export { addDays, dayEndsAt, releaseDay, RELEASE_TIME_ZONE };

/** The first playable (archive) day. */
export const CONTENT_START = '2026-09-27';
/** The first ranked day (the public launch); earlier days are unranked practice for everyone. */
export const RANKED_START = '2026-09-29';
export const pistasCalendar = createDailyCalendar({ contentStart: CONTENT_START, rankedStart: RANKED_START });
export const { lastDay, dayNumber, isPlayableDay, rankedDay, isClosedDay, boardDay } = pistasCalendar;
