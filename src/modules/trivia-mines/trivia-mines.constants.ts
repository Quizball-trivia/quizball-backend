/**
 * Trivia Mines — house-banked solo mini game.
 *
 * 25 tiles hide 4 defenders. Each safe pick multiplies the pot by the fair
 * inverse-survival odds times a 97% return, in integer basis points, so every
 * state's EV stays below 1 whatever the strategy. Three scouting questions per
 * round; a correct answer flags one hidden defender.
 */
export const BOARD_SIZE = 25;
export const DEFENDERS = 4;
export const SCOUTS_PER_ROUND = 3;
export const MAX_SAFE_PICKS = BOARD_SIZE - DEFENDERS;

export const TRIVIA_MINES_MIN_STAKE = 5;
export const TRIVIA_MINES_MAX_STAKE = 500;
export const TRIVIA_MINES_POT_CAP = 50_000;

/**
 * Pricing is per board state, not per pick count: a pick multiplies the fair
 * pot by unknown/(unknown − hidden), where unknown = tiles neither opened nor
 * flagged and hidden = defenders not yet flagged. Scouting therefore lowers the
 * odds AND the step, and the single 3% margin is taken at cash-out — every
 * strategy, with or without scouts, returns 97% before the cap.
 */
export const MARGIN_BP = 9_700;

export function fairStepBp(unknownTiles: number, hiddenDefenders: number): number {
  const safe = unknownTiles - hiddenDefenders;
  if (safe <= 0 || hiddenDefenders < 0) throw new Error('No safe tile left to price');
  return Math.round((10_000 * unknownTiles) / safe);
}

/** Pots are tracked in milli-coins so a 5-coin stake does not lose a fifth of every step to flooring. */
export const MILLI = 1_000;

/** Fair pot (milli-coins) after one more safe pick from the given state, capped. */
export function fairPotAfterPick(fairPotMilli: number, unknownTiles: number, hiddenDefenders: number): number {
  return Math.min(TRIVIA_MINES_POT_CAP * MILLI, Math.floor((fairPotMilli * fairStepBp(unknownTiles, hiddenDefenders)) / 10_000));
}

/** What the player receives on cash-out, in whole coins: fair pot minus the house margin, rounded once. */
export function cashoutValue(fairPotMilli: number): number {
  return Math.floor((fairPotMilli * MARGIN_BP) / 10_000 / MILLI);
}

/** 10s visible timer + 2s network grace, enforced server-side. */
export const QUESTION_WINDOW_MS = 12_000;
/** No heartbeat for this long → the round is auto-settled. */
export const STALE_AFTER_MS = 45_000;
export const QUESTION_CANDIDATES = 50;
export const RECENT_QUESTION_WINDOW = 200;

export const TRIVIA_MINES_STAKE_EVENT = 'trivia_mines_stake';
export const TRIVIA_MINES_PAYOUT_EVENT = 'trivia_mines_payout';
export const TRIVIA_MINES_REFUND_EVENT = 'trivia_mines_refund';
export const FAIRNESS_VERSION = 1;

export const stakeIdempotencyKey = (roundId: string) => `triviamines:${roundId}:stake`;
export const payoutIdempotencyKey = (roundId: string) => `triviamines:${roundId}:payout`;
export const refundIdempotencyKey = (roundId: string) => `triviamines:${roundId}:refund`;
