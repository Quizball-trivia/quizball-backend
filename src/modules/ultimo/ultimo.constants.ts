export { UL_ANSWER_MAX_LENGTH, UL_MAX_MISSES, UL_TURN_MIN_MS, UL_TURN_START_MS, UL_TURN_STEP_MS, turnMsFor } from './ultimo.match.js';

export const CATEGORIES_PER_DAY = 5;
/** Solo points: one per answer named, plus this for naming a whole list. */
export const COMPLETE_BONUS = 5;
/** The category's title is shown this long before its first answer clock starts (the clock includes it). */
export const REVEAL_MS = 3_500;
/** Network slack on every answer deadline: an answer sent in time is not refused for its trip. */
export const ANSWER_GRACE_MS = 1_500;
export const LEADERBOARD_TOP = 20;
export const LEADERBOARD_CACHE_MS = 15_000;
/** How often a replica checks ultimo_days for a newer seed (a cheap fingerprint query). */
export const CONTENT_REFRESH_MS = 30_000;
/** Upper bounds for the table checks: 5 categories × 60 answers, plus the bonus. */
export const MAX_ANSWERS = CATEGORIES_PER_DAY * 60;
export const MAX_SCORE = MAX_ANSWERS + CATEGORIES_PER_DAY * COMPLETE_BONUS;
