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
