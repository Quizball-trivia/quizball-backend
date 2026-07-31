/**
 * Season 2026 RP formula — the pure, side-effect-free delta math.
 *
 * Extracted verbatim from ranked.service.ts so BOTH the live settlement path
 * (which re-exports these) and offline tooling (the persistent-bot burn-in
 * dry-run report, which must predict outcomes WITHOUT writing) compute RP from
 * a single source of truth. ranked.service.ts re-exports every symbol here and
 * a unit test asserts the re-exported bindings are identical, so the two can
 * never drift.
 *
 * Transparent, margin-based scoring (replaces the old Elo-style delta). A win is
 * worth a flat base by how it was decided, plus a goal-margin bonus, plus a
 * small bonus for beating a higher-ranked opponent. Losses subtract.
 */

import type { PlacementStatus, RankedTier } from '../ranked/ranked.types.js';
import { qpForResult } from '../weekend-league/wl-week.js';

export type WinnerDecision =
  | 'goals'
  | 'penalty_goals'
  | 'total_points_fallback'
  | 'forfeit'
  | null;

export const SEASON_INITIAL_RP = 450;

export const SEASON_REGULAR_WIN_RP = 50;
export const SEASON_PENALTY_WIN_RP = 35;
export const SEASON_REGULAR_LOSS_RP = -25;
export const SEASON_PENALTY_LOSS_RP = -15;
export const SEASON_FORFEIT_LOSS_RP = -50; // you quit
export const SEASON_OPPONENT_FORFEIT_WIN_RP = 50; // opponent quit → you get a regular win
export const SEASON_BEAT_STRONGER_BONUS_RP = 10; // opponent's current RP was higher than yours

const DEFAULT_PLACEMENT_MATCHES = 3;
const RANKED_WIN_COINS = 300;
const RANKED_LOSS_COINS = 100;

// Goal-margin bonus added to a win (by goal difference). Win by 1 → +0.
// Signed margin: bonus only when the player was AHEAD (margin > 0). A winner who
// took the result while behind on goals (e.g. an opponent-forfeit win at 0-2)
// earns no margin bonus.
export function seasonMarginBonus(signedGoalMargin: number): number {
  if (signedGoalMargin >= 4) return 40;
  if (signedGoalMargin === 3) return 30;
  if (signedGoalMargin === 2) return 15;
  return 0;
}

/**
 * Season 2026 RP delta for one player in a settled match.
 * @param isWin            did this player win
 * @param decision         how the winner was decided ('penalty_goals' = shootout,
 *                         'forfeit' = a player quit, else a regular goals result)
 * @param goalMargin       signed myGoals - oppGoals (bonuses a win only when ahead)
 * @param opponentIsStronger  opponent's current RP was strictly higher than mine
 */
export function computeSeasonRpDelta(
  isWin: boolean,
  decision: WinnerDecision,
  goalMargin: number,
  opponentIsStronger: boolean,
): number {
  const isPenalty = decision === 'penalty_goals';
  const isForfeit = decision === 'forfeit';

  if (!isWin) {
    if (isForfeit) return SEASON_FORFEIT_LOSS_RP; // -50: this player quit
    return isPenalty ? SEASON_PENALTY_LOSS_RP : SEASON_REGULAR_LOSS_RP; // -15 / -25
  }

  const regularWinBaseRp = isForfeit ? SEASON_OPPONENT_FORFEIT_WIN_RP : SEASON_REGULAR_WIN_RP;
  let delta = isPenalty ? SEASON_PENALTY_WIN_RP : regularWinBaseRp; // +35 / +50
  // Margin bonus only applies to a decisive (goals) win — a shootout is by
  // definition level on goals, so no margin bonus there.
  if (!isPenalty) delta += seasonMarginBonus(goalMargin);
  if (opponentIsStronger) delta += SEASON_BEAT_STRONGER_BONUS_RP; // +10
  return delta;
}

export interface ParticipantSettlementInput {
  oldRp: number;
  placementStatus: PlacementStatus;
  placementPlayed: number;
  placementWins: number;
  placementSeedRp: number | null;
  placementPerfSum: number;
  placementPointsForSum: number;
  placementPointsAgainstSum: number;
  currentWinStreak: number;
  placementRequired: number;
  isWin: boolean;
  decision: WinnerDecision;
  goalMargin: number;
  opponentRp: number;
  opponentIsStronger: boolean;
  isHumanForCoins: boolean;
}

export interface ParticipantSettlement {
  newRp: number;
  deltaRp: number;
  oldTier: RankedTier;
  newTier: RankedTier;
  result: 'win' | 'loss';
  isPlacement: boolean;
  placementStatus: PlacementStatus;
  placementPlayed: number;
  placementWins: number;
  placementSeedRp: number | null;
  placementPerfSum: number;
  placementPointsForSum: number;
  placementPointsAgainstSum: number;
  currentWinStreak: number;
  placementGameNo: number | null;
  placementAnchorRp: number | null;
  placementPerfScore: number | null;
  calculationMethod: 'placement_seed' | 'ranked_formula';
  coinsAwarded: number;
  /**
   * Weekend League qualification points earned by this result (win 25 / loss
   * 10), humans only — the same gate as coins, so bots and ephemeral AI never
   * accrue QP. Whether the points actually land is decided at write time by
   * the match's ended_at falling inside the Mon–Fri accrual window.
   */
  qpAwarded: number;
}

// Season 2 curve — recalibrated from Season 1 prod data (94 GOATs, 49 players
// past 10k RP): early tiers stay cheap, steps grow toward the top so GOAT is
// elite again. Keep in sync with web's RANKED_TIER_BANDS (utils/rankedTier.ts).
export function tierFromRp(rp: number): RankedTier {
  if (rp >= 9000) return 'GOAT';
  if (rp >= 6800) return 'Legend';
  if (rp >= 5200) return 'World-Class';
  if (rp >= 4000) return 'Captain';
  if (rp >= 3000) return 'Key Player';
  if (rp >= 2200) return 'Starting11';
  if (rp >= 1500) return 'Rotation';
  if (rp >= 1000) return 'Bench';
  if (rp >= 600) return 'Reserve';
  if (rp >= 300) return 'Youth Prospect';
  return 'Academy';
}

export function computeParticipantSettlement(
  input: ParticipantSettlementInput,
): ParticipantSettlement {
  const result: 'win' | 'loss' = input.isWin ? 'win' : 'loss';
  const oldTier = tierFromRp(input.oldRp);
  const isPlacement = input.placementStatus !== 'placed'
    || input.placementPlayed < input.placementRequired;

  let newRp = input.oldRp;
  let deltaRp = 0;
  let newTier = oldTier;
  let placementStatus = input.placementStatus;
  let placementPlayed = input.placementPlayed;
  let placementWins = input.placementWins;
  let placementSeedRp = input.placementSeedRp;
  let placementPerfSum = input.placementPerfSum;
  let placementPointsForSum = input.placementPointsForSum;
  let placementPointsAgainstSum = input.placementPointsAgainstSum;
  const currentWinStreak = input.isWin ? input.currentWinStreak + 1 : 0;

  let placementGameNo: number | null = null;
  let placementAnchorRp: number | null = null;
  const placementPerfScore: number | null = null;
  let calculationMethod: 'placement_seed' | 'ranked_formula' = 'ranked_formula';

  const seasonDeltaRp = computeSeasonRpDelta(
    input.isWin,
    input.decision,
    input.goalMargin,
    input.opponentIsStronger,
  );

  if (isPlacement) {
    calculationMethod = 'placement_seed';
    placementStatus = 'in_progress';
    placementPlayed = Math.min(DEFAULT_PLACEMENT_MATCHES, input.placementPlayed + 1);
    placementWins = input.placementWins + (input.isWin ? 1 : 0);
    placementGameNo = placementPlayed;
    placementAnchorRp = input.opponentRp;

    newRp = Math.max(0, input.oldRp + seasonDeltaRp);
    deltaRp = newRp - input.oldRp;
    newTier = tierFromRp(newRp);

    if (placementPlayed >= DEFAULT_PLACEMENT_MATCHES) {
      placementStatus = 'placed';
      placementSeedRp = newRp;
      placementPerfSum = 0;
      placementPointsForSum = 0;
      placementPointsAgainstSum = 0;
    }
  } else {
    calculationMethod = 'ranked_formula';
    newRp = Math.max(0, input.oldRp + seasonDeltaRp);
    deltaRp = newRp - input.oldRp;
    newTier = tierFromRp(newRp);
  }

  const coinsAwarded = input.isHumanForCoins
    ? (input.isWin ? RANKED_WIN_COINS : RANKED_LOSS_COINS)
    : 0;
  const qpAwarded = input.isHumanForCoins ? qpForResult(result) : 0;

  return {
    newRp,
    deltaRp,
    oldTier,
    newTier,
    result,
    isPlacement,
    placementStatus,
    placementPlayed,
    placementWins,
    placementSeedRp,
    placementPerfSum,
    placementPointsForSum,
    placementPointsAgainstSum,
    currentWinStreak,
    placementGameNo,
    placementAnchorRp,
    placementPerfScore,
    calculationMethod,
    coinsAwarded,
    qpAwarded,
  };
}
