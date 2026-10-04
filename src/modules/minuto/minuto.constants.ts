export const GOALS_PER_DAY = 10;
/** Exact = 3 points per goal. */
export const MAX_POINTS_PER_GOAL = 3;
export const MAX_SCORE = GOALS_PER_DAY * MAX_POINTS_PER_GOAL;
export const LEADERBOARD_TOP = 20;
export const LEADERBOARD_CACHE_MS = 15_000;
/** How often a replica checks minuto_days for a newer seed (a cheap fingerprint query). */
export const CONTENT_REFRESH_MS = 30_000;
