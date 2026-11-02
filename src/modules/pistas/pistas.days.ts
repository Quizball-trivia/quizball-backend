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
/**
 * The first day served with the specific-first clue order (see orderClues in pistas.content.ts). Earlier days keep
 * their stored order, so runs played (or reviewed) on them never see their clues move. Must be a day no one has
 * opened yet when this ships: if the deploy slips past it, move it to the first day released after the deploy.
 */
export const CLUE_ORDER_FROM = '2026-11-04';
/** Days with content, counted from CONTENT_START. */
export const PUBLISHED_DAYS = 60;

export const pistasCalendar = createDailyCalendar({ contentStart: CONTENT_START, rankedStart: RANKED_START, publishedDays: PUBLISHED_DAYS });
export const { LAST_DAY, dayNumber, isPlayableDay, rankedDay, isClosedDay, boardDay } = pistasCalendar;
