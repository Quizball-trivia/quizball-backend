export const CELLS = 9;
/** One guess per cell: a wrong name costs a cell, as in the two-player game a wrong name costs the turn. */
export const GUESSES = 9;
/** A run is timed against an hour; the seconds left are the board's tie-break. */
export const SPEED_CAP_SECONDS = 3_600;
export const LEADERBOARD_TOP = 20;
export const LEADERBOARD_CACHE_MS = 15_000;
export const CONTENT_REFRESH_MS = 30_000;
/** Best-known answers shown per cell once a day has closed. */
export const REVIEW_SAMPLES_PER_CELL = 5;
