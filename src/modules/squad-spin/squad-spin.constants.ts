/**
 * Squad Spin — house-banked solo mini game.
 *
 * A run is a chain of spins. Each spin lands the reels on a combo (club · nation ·
 * position, plus league/manager/trophy reels on 4- and 5-reel runs) and the player
 * has 15s to name a footballer who fits every reel. A correct answer multiplies the
 * FAIR pot by 1/p(tier), where p is the measured human accuracy for that tier; the
 * single house margin is taken at cash-out, so every strategy returns the same RTP.
 * The cash-out / spin-again decision is made BEFORE the next combo is shown.
 */
export const SQUAD_SPIN_MIN_STAKE = 5;
export const SQUAD_SPIN_MAX_STAKE = 500;
export const SQUAD_SPIN_POT_CAP = 50_000;
/** A run banks automatically after this many correct answers or once the pot reaches RUN_MULT_CAP × stake. */
export const MAX_SPINS_PER_RUN = 10;
export const RUN_MULT_CAP_BP = 400_000;
export const SQUAD_SPIN_REEL_COUNTS = [3, 4, 5] as const;
export type SquadSpinReels = (typeof SQUAD_SPIN_REEL_COUNTS)[number];

export const SQUAD_SPIN_TIERS = ['t3e', 't3m', 't4', 't5'] as const;
export type SquadSpinTier = (typeof SQUAD_SPIN_TIERS)[number];

/** Cold-start accuracy priors per tier (share of spins answered correctly in time). */
export const TIER_PRIOR_ACCURACY_BP: Record<SquadSpinTier, number> = { t3e: 7_000, t3m: 5_500, t4: 4_500, t5: 3_500 };
/** Pseudo-observations the prior is worth when blended with measured answers. */
export const CALIBRATION_PRIOR_STRENGTH = 300;
export const CALIBRATION_WINDOW_DAYS = 30;
export const CALIBRATION_MIN_ACCURACY_BP = 2_500;
export const CALIBRATION_MAX_ACCURACY_BP = 9_500;
/** Pricing may treat players as near-perfect, so even a perfect solver stays below break-even after the margin. */
export const PRICING_MAX_ACCURACY_BP = 9_900;
/**
 * Accuracy may fall (steps rise) by at most this much per day: deliberately
 * losing cheap spins to inflate tomorrow's multipliers is throttled, while a
 * rise in accuracy (steps fall, safer for the house) applies immediately.
 */
export const CALIBRATION_MAX_DAILY_DROP_BP = 500;
/** Measured accuracy can never sit more than this below the prior, whatever the observations say. */
export const CALIBRATION_MAX_DRIFT_BELOW_PRIOR_BP = 1_000;
/** One account contributes at most this many answers per tier to a calibration window. */
export const CALIBRATION_MAX_ANSWERS_PER_USER = 200;
/**
 * Steps are priced for a player this much better than the measured population,
 * so the strongest fans sit near break-even instead of compounding an edge.
 */
export const PRICING_SKILL_GAP_BP = 1_000;
/** A combo is not dealt again to the same player for this long. */
export const SEEN_COMBO_WINDOW_DAYS = 90;
export const CALIBRATION_RULES_VERSION = 1;

export const MARGIN_BP = 9_700;
/** Until every tier has this many human answers the margin carries an extra haircut. */
export const LAUNCH_HAIRCUT_BP = 9_000;
export const LAUNCH_HAIRCUT_MIN_SAMPLES = 2_000;

/** 15s visible timer + transport grace, enforced server-side. */
export const QUESTION_MS = 15_000;
export const NETWORK_GRACE_MS = 1_500;
export const QUESTION_WINDOW_MS = QUESTION_MS + NETWORK_GRACE_MS;
/** Cash-out or spin-again must be chosen within this window; silence banks the pot. */
export const DECISION_MS = 5 * 60_000;
/** Heartbeat horizon for the "playing now" counter. */
export const PLAYING_NOW_WINDOW_S = 90;
export const FAIRNESS_VERSION = 1;
/** Bounded rejection attempts when a derived combo repeats within the run. */
export const COMBO_PICK_ATTEMPTS = 8;

export const SQUAD_SPIN_STAKE_EVENT = 'squad_spin_stake';
export const SQUAD_SPIN_PAYOUT_EVENT = 'squad_spin_payout';

export const stakeIdempotencyKey = (roundId: string) => `squadspin:${roundId}:stake`;
export const payoutIdempotencyKey = (roundId: string) => `squadspin:${roundId}:payout`;

export function tierFor(reels: number, nAnswers: number): SquadSpinTier {
  if (reels >= 5) return 't5';
  if (reels === 4) return 't4';
  return nAnswers >= 3 ? 't3e' : 't3m';
}

/** Fair step for a tier: 1 / accuracy, in basis points. */
export function fairStepBp(accuracyBp: number): number {
  if (accuracyBp <= 0) throw new Error('Accuracy must be positive');
  return Math.max(10_000, Math.round((10_000 * 10_000) / accuracyBp));
}

/** The most a run can hold: the global cap or RUN_MULT_CAP × stake, whichever is lower. */
export function runPotCap(stakeCoins: number): number {
  return Math.min(SQUAD_SPIN_POT_CAP, Math.floor((stakeCoins * RUN_MULT_CAP_BP) / 10_000));
}

/** Fair pot after one more correct answer, floored, capped for the run. */
export function fairPotAfterSpin(fairPot: number, stepBp: number, stakeCoins: number): number {
  return Math.min(runPotCap(stakeCoins), Math.floor((fairPot * stepBp) / 10_000));
}

/** What the player receives on cash-out: fair pot minus the (frozen) margin. */
export function cashoutValue(fairPot: number, marginBp: number): number {
  return Math.floor((fairPot * marginBp) / 10_000);
}
