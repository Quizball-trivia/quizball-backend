import { addDays, createDailyCalendar, dayEndsAt, releaseDay, RELEASE_TIME_ZONE } from '../daily/daily.calendar.js';

/** Football Horserace daily calendar: the daily-game calendar (Buenos Aires days). Mirrors the web calendar exactly. */
export { addDays, dayEndsAt, releaseDay, RELEASE_TIME_ZONE };

/** The first playable (archive) day: guests play closed days, so the launch needs a few behind it. Set at release. */
export const CONTENT_START = '2026-10-13';
/** The first ranked day (the public launch); earlier days are unranked practice for everyone. Set at release. */
export const RANKED_START = '2026-10-15';
/** Days with content, counted from CONTENT_START (to 2026-12-31). */
export const PUBLISHED_DAYS = 80;

export const footballRaceCalendar = createDailyCalendar({ contentStart: CONTENT_START, rankedStart: RANKED_START, publishedDays: PUBLISHED_DAYS });
export const { LAST_DAY, dayNumber, isPlayableDay, rankedDay, isClosedDay, boardDay } = footballRaceCalendar;
