import { addDays, dayEndsAt, releaseDay, RELEASE_TIME_ZONE } from '../buscaminas/buscaminas.days.js';

/**
 * Pistas futboleras release calendar (Buenos Aires days, like Buscaminas) with no future or preview
 * days: a day becomes playable at its own midnight. Mirrors the web calendar exactly.
 */
export { addDays, dayEndsAt, releaseDay, RELEASE_TIME_ZONE };

/** The first playable (archive) day. */
export const CONTENT_START = '2026-09-27';
/** The first ranked day (the public launch); earlier days are unranked practice for everyone. */
export const RANKED_START = '2026-09-29';
/** Days with content, counted from CONTENT_START. */
export const PUBLISHED_DAYS = 30;

export const LAST_DAY = addDays(CONTENT_START, PUBLISHED_DAYS - 1);

const DAY_MS = 86_400_000;

/** 1 for CONTENT_START. */
export const dayNumber = (day: string): number =>
  Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${CONTENT_START}T00:00:00Z`)) / DAY_MS) + 1;

/** CONTENT_START <= day <= min(today, LAST_DAY): never a future day. */
export function isPlayableDay(day: string, now: Date = new Date()): boolean {
  const today = releaseDay(now);
  return day >= CONTENT_START && day <= today && day <= LAST_DAY;
}

/** Today while it is a ranked day (RANKED_START … LAST_DAY); otherwise nothing is ranked. */
export function rankedDay(now: Date = new Date()): string | null {
  const today = releaseDay(now);
  return today >= RANKED_START && today <= LAST_DAY ? today : null;
}

/** Already over in Buenos Aires by this clock (the app's); answers gate on the database clock instead. */
export const isClosedDay = (day: string, now: Date = new Date()): boolean => day < releaseDay(now);

/** Default leaderboard day: the ranked day, else the launch day before launch and the last day after the run. */
export function boardDay(now: Date = new Date()): string {
  const ranked = rankedDay(now);
  if (ranked) return ranked;
  return releaseDay(now) < RANKED_START ? RANKED_START : LAST_DAY;
}
