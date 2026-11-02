export const ROUNDS_PER_DAY = 20;
/**
 * The daily run: the board's first rounds. Its score is what the day's leaderboard ranks; the
 * remaining rounds are an optional extended challenge that never changes the ranked score.
 */
export const DAILY_ROUNDS = 5;
export const PERFECT_BONUS = 3;
export const MAX_SCORE = 300;
export const LEADERBOARD_TOP = 20;
export const LEADERBOARD_CACHE_MS = 15_000;
export const CARDS_PER_ROUND = 16;
export const TARGETS_PER_ROUND = 12;
/** How often a replica checks buscaminas_days for a newer seed (a cheap fingerprint query). */
export const CONTENT_REFRESH_MS = 30_000;
