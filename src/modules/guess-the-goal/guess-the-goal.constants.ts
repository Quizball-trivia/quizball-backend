/** Scoring: guess at move 1 = MAX, decays linearly per revealed main step to
 *  MIN at full reveal; replays of a previously seen goal are clamped to MIN. */
export const GGT_MAX_POINTS = 100;
export const GGT_MIN_POINTS = 40;
export const GGT_BONUS_POINTS = 40;

/** Network/reaction grace subtracted from server-side elapsed time before
 *  mapping it to revealed moves. */
export const GGT_GRACE_MS = 1_000;

/** Rewards are paid only on the first-ever solve of a goal. */
export const GGT_COINS_PER_POINT = 0.25;
export const GGT_XP_PER_POINT = 0.5;

/** Soft daily faucet cap: once today's guess-the-goal coins reach this, further
 *  solves still pay XP but no coins. */
export const GGT_DAILY_COIN_CAP = 300;

/** A session with no guess after this long can be replaced by a new one. */
export const GGT_SESSION_STALE_MS = 30 * 60 * 1000;

export const GGT_REWARD_EVENT = 'guess_the_goal_reward';
export const GGT_XP_SOURCE = 'guess_the_goal_solve';
