/** Fixed rules for Freecroco ranked matches. */

/**
 * Every partner match's bot plays at the strength of a fixed rating (correctness/delay from the same RP curve as
 * Quizball's bridge), without the calibrated per-bot model or governor offset: partner results never tune bots.
 */
export const PARTNER_BOT_FIXED_RP = 1000;

/**
 * Anti-collusion (plan v4 §11 A.6, owner question 6, proposed 2): two Freecroco players meet at most this many times
 * per Tbilisi day; past that, each is given a bot instead.
 */
export const PARTNER_SAME_OPPONENT_DAILY_CAP = 2;
