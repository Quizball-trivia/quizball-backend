/** Scoring: guess fast = MAX, decaying linearly over GGT_FULL_POINTS_SECONDS
 *  of server-clock play to MIN; replays of a previously seen goal are clamped
 *  to MIN. */
export const GGT_MAX_POINTS = 100;
export const GGT_MIN_POINTS = 40;
export const GGT_BONUS_POINTS = 40;

/** Network/reaction grace subtracted from server-side elapsed time before
 *  decay starts. Sized so seeing the first move AND reading four option
 *  labels doesn't already cost points (the old 1s window scored the whole
 *  range before most phones finished rendering the options). */
export const GGT_GRACE_MS = 2_500;

/** Seconds of play (after grace) over which the score decays MAX→MIN.
 *  Time-based, not move-count-based: authored step counts vary 2–7, so move
 *  decay burned the whole range in ~3s on short goals and made identical
 *  skill score differently per goal. */
export const GGT_FULL_POINTS_SECONDS = 10;

/** Rewards are paid only on the first-ever solve of a goal. */
export const GGT_COINS_PER_POINT = 0.25;
export const GGT_XP_PER_POINT = 0.5;

/** Soft daily faucet cap: once today's guess-the-goal coins reach this, further
 *  solves still pay XP but no coins. */
export const GGT_DAILY_COIN_CAP = 300;

/** Hard daily play limit — distinct from the coin cap above, which only stops
 *  rewards. Once this many goals have been STARTED today the mode is closed
 *  until the next reset, so the pool lasts and the mode stays a daily ritual. */
export const GGT_DAILY_GOAL_LIMIT = 5;

/** The player-facing day boundary is Georgia local midnight (the daily
 *  challenge uses the same one), NOT UTC — a UTC reset would land at 04:00
 *  for players and read as arbitrary. */
export const GGT_DAY_TIMEZONE = 'Asia/Tbilisi';

export const GGT_REWARD_EVENT = 'guess_the_goal_reward';
export const GGT_XP_SOURCE = 'guess_the_goal_solve';
