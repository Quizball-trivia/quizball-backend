export const ROAD_TO_GOAL_ZONES = 11;

export const ROAD_TO_GOAL_STAKES = [10, 25, 50] as const;
export type RoadToGoalStake = (typeof ROAD_TO_GOAL_STAKES)[number];

/** Fixed return multipliers for clearing zones 1..11, in basis points. */
export const ROAD_TO_GOAL_MULTIPLIERS_BP = [
  10_300,
  10_800,
  11_500,
  12_400,
  13_600,
  15_200,
  17_200,
  19_800,
  23_500,
  29_000,
  40_000,
] as const;

export const ROAD_TO_GOAL_DIFFICULTIES = [
  'easy',
  'easy',
  'easy',
  'easy',
  'medium',
  'medium',
  'medium',
  'medium',
  'hard',
  'hard',
  'hard',
] as const;

/** The UI displays fifteen seconds; a small transport grace avoids penalizing a
 * correct answer that was sent before zero but arrived just after it. */
export const ROAD_TO_GOAL_QUESTION_MS = 15_000;
export const ROAD_TO_GOAL_NETWORK_GRACE_MS = 1_500;
export const ROAD_TO_GOAL_SERVER_WINDOW_MS =
  ROAD_TO_GOAL_QUESTION_MS + ROAD_TO_GOAL_NETWORK_GRACE_MS;

export const ROAD_TO_GOAL_CANDIDATES_PER_DIFFICULTY = 64;
export const ROAD_TO_GOAL_FALLBACK_CANDIDATES_PER_DIFFICULTY =
  ROAD_TO_GOAL_CANDIDATES_PER_DIFFICULTY * 2;
export const ROAD_TO_GOAL_DECISION_MS = 5 * 60_000;

export const ROAD_TO_GOAL_ACCURACY_PRIORS_BP = {
  easy: 8_000,
  medium: 6_500,
  hard: 5_000,
} as const;

export const ROAD_TO_GOAL_CALIBRATION_MIN_ROAD_ANSWERS = 100;
export const ROAD_TO_GOAL_CALIBRATION_INTERVAL_MS = 60 * 60_000;

/** Survivor-conditioned cold-start priors. These come from the documented
 * 50/50 high/low-skill cohort model and are replaced by question+zone data as
 * the game accumulates real, non-bot observations. */
export const ROAD_TO_GOAL_ZONE_ACCURACY_PRIORS_BP = [
  8_000, 8_042, 8_084, 8_126,
  6_669, 6_713, 6_757, 6_802,
  5_347, 5_393, 5_440,
] as const;

export const ROAD_TO_GOAL_COMMITMENT_VERSION = 3 as const;
export const ROAD_TO_GOAL_COMMITMENT_MS = 5 * 60_000;

export const ROAD_TO_GOAL_STAKE_EVENT = 'road_to_goal_stake';
export const ROAD_TO_GOAL_PAYOUT_EVENT = 'road_to_goal_payout';

export const roadToGoalStakeIdempotencyKey = (roundId: string) =>
  `road-to-goal:${roundId}:stake`;
export const roadToGoalPayoutIdempotencyKey = (roundId: string) =>
  `road-to-goal:${roundId}:payout`;

export function multiplierBpForClearedZones(clearedZones: number): number {
  if (clearedZones === 0) return 10_000;
  const multiplier = ROAD_TO_GOAL_MULTIPLIERS_BP[clearedZones - 1];
  if (multiplier == null) {
    throw new RangeError(`Invalid cleared-zone count: ${clearedZones}`);
  }
  return multiplier;
}

/** Exact payout in hundredths of a coin. Multipliers have two decimal places,
 * so every supported whole-coin stake settles without rounding. */
export function payoutMinorForClearedZones(stakeCoins: number, clearedZones: number): number {
  const payoutMinor = (
    BigInt(stakeCoins) * 100n * BigInt(multiplierBpForClearedZones(clearedZones))
  ) / 10_000n;
  const payout = Number(payoutMinor);
  if (!Number.isSafeInteger(payout)) throw new RangeError('Road to Goal payout exceeds safe range');
  return payout;
}

export function payoutForClearedZones(stakeCoins: number, clearedZones: number): number {
  return payoutMinorForClearedZones(stakeCoins, clearedZones) / 100;
}

export function isRoadToGoalStake(value: number): value is RoadToGoalStake {
  return ROAD_TO_GOAL_STAKES.includes(value as RoadToGoalStake);
}
