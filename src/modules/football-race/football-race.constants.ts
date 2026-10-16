/** Everyone races to this many spaces; the rivals start ahead. */
export const SOLO_TARGET = 5;
/** Spaces the three rivals start ahead: three wrong picks that feed one rival lose the race. */
export const RIVAL_HEAD_START = 2;
/** Picks a player can make at most (a day holds fewer playable stats than this). */
export const MAX_PICKS = 400;
export const LEADERBOARD_TOP = 20;
export const LEADERBOARD_CACHE_MS = 15_000;
/** How often a replica checks football_race_days for a newer seed (a cheap fingerprint query). */
export const CONTENT_REFRESH_MS = 30_000;
