export const ROUNDS_PER_DAY = 10;
export const CLUES_PER_ROUND = 10;
/** Points for a round solved with n clues revealed: 11 − n (10 … 1). */
export const MAX_POINTS_PER_ROUND = 10;
export const MAX_SCORE = ROUNDS_PER_DAY * MAX_POINTS_PER_ROUND;
/** After the first wrong guess at most this many more clues may be revealed (never past the last clue). */
export const LAST_CHANCE_CLUES = 3;
/** Wrong guesses per round: the second one settles it as missed. */
export const MAX_WRONG_GUESSES = 2;
export const GUESS_MAX_LENGTH = 60;
export const LEADERBOARD_TOP = 20;
export const LEADERBOARD_CACHE_MS = 15_000;
/** How often a replica checks pistas_days for a newer seed (a cheap fingerprint query). */
export const CONTENT_REFRESH_MS = 30_000;
