/**
 * Free Kicks — house-banked solo mode constants.
 *
 * Payouts are integer basis points, always below fair odds k/(k-1) for a
 * 1-in-k keeper, with a margin that SHRINKS as knowledge opens more zones:
 *   k=2 → 1.86x (fair 2.00, RTP 93%) · 3 → 1.42x (95%) · 4 → 1.28x (96%)
 *   k=5 → 1.21x (97%) · 6 → 1.18x (98%)
 * Every state's EV < 1, so the house edge holds for every strategy.
 */

export const FREE_KICKS_MIN_STAKE = 5;
export const FREE_KICKS_MAX_STAKE = 500;
/** Hard pot ceiling — capping only ever lowers player EV variance, never RTP above 1. */
export const FREE_KICKS_POT_CAP = 50_000;

export const MIN_OPEN = 2;
export const MAX_OPEN = 6;

/**
 * Zone unlock order — part of the fairness contract (the HMAC maps an index
 * into this list). Versioned so clients/verifiers can never disagree.
 */
export const OPEN_ORDER = ['BL', 'BR', 'TL', 'TR', 'BC', 'TC'] as const;
export const ZONE_ORDER_VERSION = 1;
export type FreeKicksZone = (typeof OPEN_ORDER)[number];

/** Payout multipliers in basis points, keyed by open-zone count. */
export const STATE_MULT_BP: Record<number, number> = {
  2: 18600,
  3: 14200,
  4: 12800,
  5: 12100,
  6: 11800,
};

/** floor(pot × mult) in exact integer arithmetic, capped. */
export function applyMultiplier(potCoins: number, openCount: number): number {
  const bp = STATE_MULT_BP[openCount];
  if (!bp) throw new Error(`No multiplier for open count ${openCount}`);
  return Math.min(FREE_KICKS_POT_CAP, Math.floor((potCoins * bp) / 10_000));
}

export function openZones(openCount: number): readonly FreeKicksZone[] {
  return OPEN_ORDER.slice(0, openCount);
}

/** 5s visible timer + 2s network grace, enforced server-side. */
export const QUESTION_WINDOW_MS = 7_000;

/** Client heartbeat cadence is ~10s; a round with no heartbeat for this long
 *  is auto-settled (post-goal pots are cashed out; anything else expires). */
export const STALE_AFTER_MS = 45_000;

/** How many candidate questions one deal may examine. */
export const QUESTION_CANDIDATES = 50;
/** How many recently served questions to exclude per user. */
export const RECENT_QUESTION_WINDOW = 200;

export const FREE_KICKS_STAKE_EVENT = 'free_kicks_stake';
export const FREE_KICKS_PAYOUT_EVENT = 'free_kicks_payout';

export const stakeIdempotencyKey = (roundId: string) => `freekicks:${roundId}:stake`;
export const payoutIdempotencyKey = (roundId: string) => `freekicks:${roundId}:payout`;
